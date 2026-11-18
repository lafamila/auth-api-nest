import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AesGcmService } from '../../common/crypto/aes-gcm.service';
import { AppConfigService } from '../../config/app-config.service';
import { AccountLifecycleService } from '../../portal/account-lifecycle.service';
import {
  EVENT_TTL_MS,
  VerifiedProviderEvent,
  providerEventIdentitySnapshot,
} from './provider-event.types';
import { ProviderEventsService } from './provider-events.service';

const event: VerifiedProviderEvent = {
  provider: 'naver',
  deduplicationId: 'authenticated-opaque-event-id',
  targets: [
    {
      clientId: 'client-not-in-cleartext',
      subject: 'private-stable-subject',
      kind: 'unlinked',
    },
  ],
};
const identity = {
  id: 'observed-identity-id',
  encryptedRevocationGrant: 'stored-encrypted-grant',
};
const queuedTargets = () =>
  event.targets.map((target) => ({
    ...target,
    expectedSnapshot: providerEventIdentitySnapshot(identity),
  }));

describe('ProviderEventsService durable receipt queue', () => {
  const config = new AppConfigService(
    new ConfigService({
      NODE_ENV: 'test',
      ADMIN_OTP_ENCRYPTION_KEY: 'test-encryption-key',
    }),
  );
  const crypto = new AesGcmService(config);
  let query: jest.Mock;
  let consume: jest.Mock;
  let warn: jest.SpyInstance;
  let service: ProviderEventsService;

  beforeEach(() => {
    query = jest
      .fn()
      .mockImplementation(async (sql: string) =>
        sql.startsWith('SELECT') ? [identity] : [],
      );
    consume = jest.fn().mockResolvedValue(undefined);
    service = new ProviderEventsService(
      { query } as unknown as DataSource,
      crypto,
      config,
      { consumeProviderEvent: consume } as unknown as AccountLifecycleService,
    );
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('atomically persists an encrypted work item and dedup fence before resolving, without processing on the ACK path', async () => {
    let finish!: () => void;
    let started!: () => void;
    const inserting = new Promise<void>((resolve) => {
      started = resolve;
    });
    query.mockImplementation((sql: string) =>
      sql.startsWith('SELECT')
        ? Promise.resolve([identity])
        : new Promise<void>((resolve) => {
            finish = resolve;
            started();
          }),
    );
    let acknowledged = false;
    const pending = service.enqueue(event).then(() => {
      acknowledged = true;
    });
    await inserting;
    expect(acknowledged).toBe(false);
    expect(consume).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, parameters] = query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (provider, dedup_hash) DO NOTHING');
    expect(parameters[2]).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.decrypt(parameters[3] as string)).toBe(
      JSON.stringify(queuedTargets()),
    );
    expect(JSON.stringify(parameters)).not.toMatch(
      /client-not-in-cleartext|private-stable-subject|authenticated-opaque|observed-identity-id|stored-encrypted-grant/,
    );
    expect(
      (parameters[5] as Date).getTime() - (parameters[4] as Date).getTime(),
    ).toBe(EVENT_TTL_MS);
    finish();
    await pending;
    expect(acknowledged).toBe(true);
  });

  it('derives the same DB unique fence across concurrent/restarted service instances, with provider namespace separation', async () => {
    const restarted = new ProviderEventsService(
      { query } as unknown as DataSource,
      crypto,
      config,
      { consumeProviderEvent: consume } as unknown as AccountLifecycleService,
    );
    await Promise.all([service.enqueue(event), restarted.enqueue(event)]);
    const initial = query.mock.calls.filter(([sql]: [string]) =>
      sql.startsWith('INSERT'),
    );
    expect(initial[0][1][2]).toBe(initial[1][1][2]);
    expect(initial[0][1][0]).not.toBe(initial[1][1][0]);
    await service.enqueue({ ...event, provider: 'kakao' });
    const inserts = query.mock.calls.filter(([sql]: [string]) =>
      sql.startsWith('INSERT'),
    );
    expect(inserts[2][1][2]).not.toBe(inserts[0][1][2]);
  });

  it('deduplicates Kakao within a link generation without suppressing unlink after relink', async () => {
    let generation = 'first-link-uuid';
    let encryptedRevocationGrant: string | null = null;
    query.mockImplementation(async (sql: string) =>
      sql.startsWith('SELECT')
        ? [{ id: generation, encryptedRevocationGrant }]
        : [],
    );
    const kakao = { ...event, provider: 'kakao' as const };
    await service.enqueue(kakao);
    await service.enqueue(kakao);
    generation = 'second-link-uuid';
    await service.enqueue(kakao);
    encryptedRevocationGrant = 'fresh-grant-same-identity';
    await service.enqueue(kakao);
    const inserts = query.mock.calls.filter(([sql]: [string]) =>
      sql.startsWith('INSERT'),
    );
    expect(inserts[0][1][2]).toBe(inserts[1][1][2]);
    expect(inserts[2][1][2]).not.toBe(inserts[0][1][2]);
    expect(inserts[3][1][2]).not.toBe(inserts[2][1][2]);
    expect(JSON.stringify(inserts)).not.toContain('link-uuid');
    expect(consume).not.toHaveBeenCalled();
  });

  it('does not ACK a failed durable write', async () => {
    query.mockRejectedValue(
      new Error('database unavailable private-stable-subject'),
    );
    await expect(service.enqueue(event)).rejects.toThrow(
      'Provider event storage unavailable',
    );
    expect(consume).not.toHaveBeenCalled();
  });

  it('does not expose Kakao identity lookup errors that may contain private SQL parameters', async () => {
    query.mockRejectedValue(
      new Error('private SQL parameter: private-stable-subject'),
    );
    await expect(
      service.enqueue({ ...event, provider: 'kakao' }),
    ).rejects.toThrow('Provider event storage unavailable');
    expect(consume).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'dev-admin-otp-encryption-key-change-me', 'too-short'])(
    'refuses production receipt storage with a missing/default/short encryption key',
    async (key) => {
      const production = new AppConfigService(
        new ConfigService({
          NODE_ENV: 'production',
          ADMIN_OTP_ENCRYPTION_KEY: key,
        }),
      );
      const unsafe = new ProviderEventsService(
        { query } as unknown as DataSource,
        new AesGcmService(production),
        production,
        { consumeProviderEvent: consume } as unknown as AccountLifecycleService,
      );
      await expect(unsafe.enqueue(event)).rejects.toThrow(
        'Provider event storage unavailable',
      );
      expect(query).not.toHaveBeenCalled();
    },
  );

  function claimed(attempts = 1) {
    return {
      id: 'receipt-id',
      provider: event.provider,
      encrypted_target: crypto.encrypt(JSON.stringify(queuedTargets())),
      attempts,
      lease_token: 'lease-id',
    };
  }

  it('processes a persisted receipt offline, clears its target, and retains the dedup fence', async () => {
    // Exercise the PostgreSQL UPDATE RETURNING driver shape, not only plain rows.
    query.mockResolvedValueOnce([[claimed()], 1]).mockResolvedValue([]);
    expect(await service.processOnce()).toBe(true);
    expect(consume).toHaveBeenCalledWith(
      'naver',
      event.targets[0].clientId,
      event.targets[0].subject,
      'unlinked',
      providerEventIdentitySnapshot(identity),
    );
    const [claimSql] = query.mock.calls[0] as [string];
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED LIMIT 1');
    expect(claimSql).toContain('lease_until <= now()');
    const [doneSql, doneArgs] = query.mock.calls[1] as [string, unknown[]];
    expect(doneSql).toContain('encrypted_target = NULL');
    expect(doneSql).toContain('lease_token = $2');
    expect(doneSql).not.toContain('DELETE');
    expect(doneArgs).toEqual(['receipt-id', 'lease-id']);
  });

  it('retries transient failures without deleting or logging private event data', async () => {
    consume.mockRejectedValueOnce(
      new Error('private-stable-subject token secret@example.test'),
    );
    query.mockResolvedValueOnce([claimed()]).mockResolvedValue([]);
    expect(await service.processOnce()).toBe(true);
    expect(query.mock.calls[1][0]).toContain('next_attempt_at = now()');
    expect(query.mock.calls[1][0]).not.toContain('encrypted_target = NULL');
    expect(query.mock.calls[1][1]).toEqual(['receipt-id', 'lease-id', 5]);
    expect(warn).toHaveBeenCalledWith('Provider event processing deferred');
    query.mockResolvedValueOnce([claimed(2)]).mockResolvedValue([]);
    expect(await service.processOnce()).toBe(true);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[3][0]).toContain('processed_at = now()');
  });

  it('caps retry delay but does not abandon a receipt after a fixed number of failures', async () => {
    consume.mockRejectedValue(new Error('temporary'));
    query.mockResolvedValueOnce([claimed(100)]).mockResolvedValue([]);
    await service.processOnce();
    expect(query.mock.calls[1][1]).toEqual(['receipt-id', 'lease-id', 3600]);
  });

  it('preserves an undecryptable receipt for repair rather than silently dropping it', async () => {
    query
      .mockResolvedValueOnce([{ ...claimed(), encrypted_target: 'tampered' }])
      .mockResolvedValue([]);
    await service.processOnce();
    expect(consume).not.toHaveBeenCalled();
    expect(query.mock.calls[1][0]).toContain('next_attempt_at');
  });

  it.each(['google', 'kakao', 'naver'] as const)(
    'captures identity ID and grant digest for every %s target before ACK without putting snapshots in cleartext',
    async (provider) => {
      const targets = [
        event.targets[0],
        {
          clientId: 'second-client',
          subject: 'second-subject',
          kind: 'sessions_revoked' as const,
        },
      ];
      const secondIdentity = {
        id: 'second-identity',
        encryptedRevocationGrant: null,
      };
      query.mockImplementation(async (sql: string, parameters: unknown[]) =>
        sql.startsWith('SELECT')
          ? [parameters[2] === 'second-subject' ? secondIdentity : identity]
          : [],
      );
      await service.enqueue({ ...event, provider, targets });
      const inserts = query.mock.calls.filter(([sql]: [string]) =>
        sql.startsWith('INSERT'),
      );
      const payload = JSON.parse(
        crypto.decrypt(inserts[0][1][3] as string),
      ) as unknown;
      expect(payload).toEqual([
        {
          ...targets[0],
          expectedSnapshot: providerEventIdentitySnapshot(identity),
        },
        {
          ...targets[1],
          expectedSnapshot: providerEventIdentitySnapshot(secondIdentity),
        },
      ]);
      expect(
        query.mock.calls.slice(0, 2).map(([, args]) => args as unknown),
      ).toEqual([
        [provider, targets[0].clientId, targets[0].subject],
        [provider, targets[1].clientId, targets[1].subject],
      ]);
      expect(JSON.stringify(inserts)).not.toMatch(
        /observed-identity-id|stored-encrypted-grant|second-identity|second-client|second-subject/,
      );
      expect(consume).not.toHaveBeenCalled();
    },
  );

  it('retains an explicit absent-identity snapshot when a receipt is queued before the identity exists', async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await service.enqueue(event);
    const encrypted = query.mock.calls[1][1][3] as string;
    expect(JSON.parse(crypto.decrypt(encrypted))).toEqual(
      event.targets.map((target) => ({ ...target, expectedSnapshot: null })),
    );
    query.mockClear();
    query
      .mockResolvedValueOnce([{ ...claimed(), encrypted_target: encrypted }])
      .mockResolvedValueOnce([]);
    await service.processOnce();
    expect(consume).toHaveBeenCalledWith(
      event.provider,
      event.targets[0].clientId,
      event.targets[0].subject,
      'unlinked',
      null,
    );
    expect(query.mock.calls[1][0]).toContain('processed_at = now()');
  });

  it('passes the ingested snapshot unchanged after a later grant replaces the current proof', async () => {
    await service.enqueue(event);
    const encrypted = query.mock.calls[1][1][3] as string;
    query.mockClear();
    query
      .mockResolvedValueOnce([{ ...claimed(), encrypted_target: encrypted }])
      .mockResolvedValueOnce([]);
    await service.processOnce();
    expect(consume).toHaveBeenCalledWith(
      event.provider,
      event.targets[0].clientId,
      event.targets[0].subject,
      'unlinked',
      providerEventIdentitySnapshot(identity),
    );
    expect(query.mock.calls[1][0]).toContain('processed_at = now()');
  });

  it.each([
    undefined,
    false,
    {},
    { identityId: identity.id, grantDigest: 'bad' },
  ])(
    'keeps legacy or malformed snapshot %j retryable rather than making an unbound lifecycle call',
    async (expectedSnapshot) => {
      query
        .mockResolvedValueOnce([
          {
            ...claimed(),
            encrypted_target: crypto.encrypt(
              JSON.stringify([{ ...event.targets[0], expectedSnapshot }]),
            ),
          },
        ])
        .mockResolvedValueOnce([]);
      await service.processOnce();
      expect(consume).not.toHaveBeenCalled();
      expect(query.mock.calls[1][0]).toContain('next_attempt_at');
      expect(query.mock.calls[1][0]).not.toContain('processed_at = now()');
    },
  );

  it('processes a safely ignored Google event without lifecycle actions', async () => {
    query
      .mockResolvedValueOnce([
        {
          ...claimed(),
          provider: 'google',
          encrypted_target: crypto.encrypt('[]'),
        },
      ])
      .mockResolvedValue([]);
    expect(await service.processOnce()).toBe(true);
    expect(consume).not.toHaveBeenCalled();
    expect(query.mock.calls[1][0]).toContain('processed_at = now()');
  });

  it('returns false with no due work and purges only processed receipts after 24h', async () => {
    expect(await service.processOnce()).toBe(false);
    await service.purgeProcessed();
    expect(query.mock.calls[1][0]).toBe(
      'DELETE FROM provider_events WHERE processed_at IS NOT NULL AND expires_at <= now()',
    );
    expect(consume).not.toHaveBeenCalled();
  });

  it('never starts the periodic worker in NODE_ENV=test', () => {
    jest.useFakeTimers();
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['initial', 'scheduled'])(
    'waits for the active %s tick and its purge before completing shutdown',
    async (tick) => {
      jest.useFakeTimers();
      const worker = new ProviderEventsService(
        { query } as unknown as DataSource,
        crypto,
        new AppConfigService(new ConfigService({ NODE_ENV: 'development' })),
        { consumeProviderEvent: consume } as unknown as AccountLifecycleService,
      );
      const process = jest
        .spyOn(worker, 'processOnce')
        .mockResolvedValue(false);
      const purge = jest
        .spyOn(worker, 'purgeProcessed')
        .mockResolvedValue(undefined);
      let releaseProcess!: (value: boolean) => void;
      let releasePurge!: () => void;
      const processing = new Promise<boolean>((resolve) => {
        releaseProcess = resolve;
      });
      const purging = new Promise<void>((resolve) => {
        releasePurge = resolve;
      });
      const blockTick = () => {
        process.mockReturnValueOnce(processing);
        purge.mockReturnValueOnce(purging);
      };
      try {
        if (tick === 'initial') blockTick();
        worker.onModuleInit();
        if (tick === 'scheduled') {
          await jest.advanceTimersByTimeAsync(0);
          process.mockClear();
          purge.mockClear();
          blockTick();
          await jest.advanceTimersByTimeAsync(1000);
        }
        await jest.advanceTimersByTimeAsync(3000);
        expect(process).toHaveBeenCalledTimes(1);
        expect(purge).not.toHaveBeenCalled();
        let stopped = false;
        const shutdown = Promise.resolve(worker.onModuleDestroy()).then(() => {
          stopped = true;
        });
        await Promise.resolve();
        expect(jest.getTimerCount()).toBe(0);
        expect(stopped).toBe(false);
        await jest.advanceTimersByTimeAsync(3000);
        expect(process).toHaveBeenCalledTimes(1);
        releaseProcess(false);
        await jest.advanceTimersByTimeAsync(0);
        expect(purge).toHaveBeenCalledTimes(1);
        expect(stopped).toBe(false);
        releasePurge();
        await shutdown;
        expect(stopped).toBe(true);
        await jest.advanceTimersByTimeAsync(3000);
        expect(process).toHaveBeenCalledTimes(1);
      } finally {
        releaseProcess(false);
        releasePurge();
        await jest.advanceTimersByTimeAsync(0);
        await worker.onModuleDestroy();
      }
    },
  );

  it('awaits a failed active tick during shutdown without exposing its database error', async () => {
    jest.useFakeTimers();
    const worker = new ProviderEventsService(
      { query } as unknown as DataSource,
      crypto,
      new AppConfigService(new ConfigService({ NODE_ENV: 'development' })),
      { consumeProviderEvent: consume } as unknown as AccountLifecycleService,
    );
    jest
      .spyOn(worker, 'processOnce')
      .mockRejectedValueOnce(new Error('private database details'));
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    worker.onModuleInit();
    await expect(worker.onModuleDestroy()).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
    expect(error).toHaveBeenCalledWith('Provider event queue unavailable');
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      'private database details',
    );
  });
});
