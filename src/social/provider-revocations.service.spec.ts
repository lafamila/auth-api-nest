import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import { AppConfigService } from '../config/app-config.service';
import { ProviderRevocationJobEntity } from '../database/entities/provider-revocation-job.entity';
import { SocialIdentityEntity } from '../database/entities/social-identity.entity';
import { ProviderRevocationGrant } from './provider-revocations-grant';
import {
  ProviderRevocationError,
  ProviderRevocationsClient,
} from './provider-revocations.client';
import { ProviderRevocationsService } from './provider-revocations.service';

const NOW = new Date('2026-11-18T00:00:00Z');
const DAY = 86_400_000;

describe('ProviderRevocationsService (offline persistence)', () => {
  let crypto: AesGcmService;
  let client: ProviderRevocationsClient;
  let service: ProviderRevocationsService;
  let query: jest.Mock;
  let save: jest.Mock;
  let find: jest.Mock;
  let create: jest.Mock;
  let getRepository: jest.Mock;
  let manager: EntityManager;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let settings: ConfigService;

  beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'test' });
    jest.useFakeTimers().setSystemTime(NOW);
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('unexpected network'));
    settings = new ConfigService({
      NODE_ENV: 'test',
      ADMIN_OTP_ENCRYPTION_KEY: 'isolated-test-key',
      SOCIAL_GOOGLE_CLIENT_ID: 'google-client',
      SOCIAL_NAVER_CLIENT_ID: 'naver-client',
      SOCIAL_NAVER_CLIENT_SECRET: 'naver-secret',
      SOCIAL_KAKAO_CLIENT_ID: 'kakao-client',
      SOCIAL_KAKAO_CLIENT_SECRET: 'kakao-secret',
    });
    crypto = new AesGcmService(new AppConfigService(settings));
    client = new ProviderRevocationsClient(settings);
    query = jest.fn().mockResolvedValue([]);
    save = jest.fn().mockResolvedValue([]);
    find = jest.fn().mockResolvedValue([]);
    create = jest.fn((input: unknown) => input);
    const repository = { create, save, find };
    getRepository = jest.fn(() => repository);
    manager = {
      queryRunner: { isTransactionActive: true },
      getRepository,
      query,
    } as unknown as EntityManager;
    service = new ProviderRevocationsService(
      { query, getRepository: () => repository } as unknown as DataSource,
      settings,
      crypto,
      client,
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('accepts empty identity sets and valid encrypted grants without network access', () => {
    expect(() => service.prepare([])).not.toThrow();
    expect(() =>
      service.prepare([identity('google'), identity('naver')]),
    ).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('returns a deduplicated provider list and 409 machine code before any mutation for legacy tokenless grants', async () => {
    const identities = ['naver', 'google', 'google'].map((provider) =>
      identity(provider, null),
    );
    let failure: unknown;
    try {
      service.prepare(identities);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).getStatus()).toBe(409);
    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: 'provider_reauthentication_required',
      providers: ['google', 'naver'],
    });
    await expect(
      service.enqueue(manager, identities, 'withdraw'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('permits tokenless Kakao only with the server admin key and matching configured client', () => {
    const legacy = identity('kakao', null);
    expect(() => service.prepare([legacy])).toThrow(ConflictException);
    settings.set('SOCIAL_KAKAO_ADMIN_KEY', 'admin-key');
    expect(() => service.prepare([legacy])).not.toThrow();
    legacy.providerClientId = 'other-kakao-client';
    expect(() => service.prepare([legacy])).toThrow(ConflictException);
  });

  it.each([
    { accessTokenExpiresAt: 0, refreshToken: null },
    { accessTokenExpiresAt: 0, refreshTokenExpiresAt: 0 },
    { accessTokenExpiresAt: null, refreshToken: null },
    { provider: 'naver' },
    { clientId: 'old-client' },
    { subject: 'other-subject' },
  ])(
    'requires reauthentication for expired/unbound grants: %j',
    (overrides) => {
      const linked = identity('google', encrypt(grant('google', overrides)));
      expect(() => service.prepare([linked])).toThrow(ConflictException);
    },
  );

  it('rejects tampering or extra PII fields in encrypted grants', () => {
    expect(() =>
      service.prepare([identity('google', 'v1.bad-tampered')]),
    ).toThrow(ConflictException);
    const raw = crypto.encrypt(
      JSON.stringify({
        ...grant('google'),
        email: 'not-permitted@example.com',
      }),
    );
    expect(() => service.prepare([identity('google', raw)])).toThrow(
      ConflictException,
    );
  });

  it('merges only a missing refresh token while keeping current access and expiry', () => {
    const previous = grant('google', {
      accessToken: 'old-access',
      refreshToken: 'previous-refresh',
      refreshTokenExpiresAt: Date.now() + DAY,
    });
    const next = grant('google', {
      accessToken: 'new-access',
      refreshToken: null,
      accessTokenExpiresAt: Date.now() + 7200_000,
      refreshTokenExpiresAt: null,
    });
    const result = service.mergeGrant(encrypt(previous), encrypt(next));
    expect(decrypt(result)).toEqual({
      ...next,
      refreshToken: previous.refreshToken,
      refreshTokenExpiresAt: previous.refreshTokenExpiresAt,
    });
    expect(result).not.toContain('previous-refresh');
    expect(result).not.toContain('new-access');
  });

  it('does not replace a new refresh token with an old one or resurrect expired refresh credentials', () => {
    const previous = grant('google', {
      refreshToken: 'old-refresh',
      refreshTokenExpiresAt: 0,
    });
    const next = grant('google', { refreshToken: 'new-refresh' });
    expect(
      decrypt(service.mergeGrant(encrypt(previous), encrypt(next))),
    ).toEqual(next);
    const missing = { ...next, refreshToken: null };
    expect(
      decrypt(service.mergeGrant(encrypt(previous), encrypt(missing))),
    ).toEqual(missing);
    expect(decrypt(service.mergeGrant(null, encrypt(next)))).toEqual(next);
  });

  it.each([
    { provider: 'naver' },
    { clientId: 'another-app' },
    { subject: 'another-subject' },
  ])('never merges across a different identity namespace: %j', (change) => {
    expect(() =>
      service.mergeGrant(
        encrypt(grant('google')),
        encrypt(grant('google', change)),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects malformed grants with a generic error instead of leaking decrypted content', () => {
    for (const value of [
      'raw-token',
      crypto.encrypt('{"secret":"private-token"}'),
    ]) {
      expect(() => service.mergeGrant(null, value)).toThrow(
        'Invalid provider revocation grant',
      );
    }
  });

  it('persists encrypted target copies only in the account mutation transaction with a fixed 24h deadline', async () => {
    const linked = identity('google');
    await expect(service.enqueue(manager, [linked], 'unlink')).resolves.toBe(1);
    expect(getRepository).toHaveBeenCalledWith(ProviderRevocationJobEntity);
    expect(save).toHaveBeenCalledTimes(1);
    const rows = save.mock.calls[0][0] as ProviderRevocationJobEntity[];
    const row = rows[0];
    expect(row).toMatchObject({
      status: 'pending',
      reason: 'unlink',
      attempts: 0,
      nextAttemptAt: NOW,
      createdAt: NOW,
      deadlineAt: new Date(NOW.getTime() + DAY),
      targetHash: targetHash(linked),
    });
    expect(decrypt(row.encryptedPayload!)).toEqual(grant('google'));
    expect(row.encryptedPayload).not.toBe(linked.encryptedRevocationGrant);
    expect(row).not.toHaveProperty('accountId');
    expect(row).not.toHaveProperty('subject');
    expect(row).not.toHaveProperty('provider');
    expect(JSON.stringify(row)).not.toContain('private-access-token');
    expect(JSON.stringify(row)).not.toContain('vendor-subject');
    expect(query).not.toHaveBeenCalled();
  });

  it('cannot enqueue with a global/non-transactional manager or an unknown reason', async () => {
    await expect(
      service.enqueue(
        { queryRunner: { isTransactionActive: false } } as EntityManager,
        [identity('google')],
        'withdraw',
      ),
    ).rejects.toThrow('account mutation transaction');
    await expect(
      service.enqueue(manager, [identity('google')], 'delete' as 'unlink'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('propagates insert failure so the owner can roll back the account mutation', async () => {
    save.mockRejectedValueOnce(new Error('insert failed'));
    await expect(
      service.enqueue(manager, [identity('google')], 'withdraw'),
    ).rejects.toThrow('insert failed');
  });

  it('claims with an atomic SKIP LOCKED lease and deletes encrypted payload on success', async () => {
    queueClaim();
    fetchMock.mockResolvedValueOnce(new Response(null));
    await service.processOnce();
    const sweepSql = query.mock.calls[0][0] as string;
    const claimSql = query.mock.calls[1][0] as string;
    expect(sweepSql).toContain('encrypted_payload = NULL');
    expect(sweepSql).toContain('deadline_at <= now()');
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claimSql).toContain('attempts < 8');
    expect(claimSql).toContain('lease_expires_at <= now()');
    expect(claimSql).toContain("interval '60 seconds'");
    expect(claimSql).toContain('deadline_at > now()');
    const [recordSql, params] = query.mock.calls[2] as [string, unknown[]];
    expect(recordSql).toContain('lease_token = $2');
    expect(recordSql).toContain('lease_expires_at > now()');
    expect(recordSql).toContain('THEN NULL ELSE encrypted_payload');
    expect(params).toEqual(['job-id', 'lease-id', 'succeeded', null, null]);
    expect(JSON.stringify(query.mock.calls)).not.toContain(
      'private-access-token',
    );
  });

  it.each([1, 2, 7])(
    'retries failure number %s with bounded backoff, preserving only encrypted payload',
    async (attempts) => {
      queueClaim({ attempts });
      fetchMock.mockRejectedValueOnce(new Error('private-token-secret'));
      await service.processOnce();
      const params = query.mock.calls[2][1] as unknown[];
      expect(params[2]).toBe('retry');
      expect((params[3] as Date).getTime()).toBeGreaterThan(Date.now());
      expect((params[3] as Date).getTime()).toBeLessThan(Date.now() + DAY);
      expect(params[4]).toBe('provider_unavailable');
      expect(JSON.stringify(query.mock.calls)).not.toContain(
        'private-token-secret',
      );
    },
  );

  it('wipes payload at attempt eight and requires manual follow-up', async () => {
    queueClaim({ attempts: 8 });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await service.processOnce();
    expect(query.mock.calls[2][1]).toEqual([
      'job-id',
      'lease-id',
      'manual_required',
      null,
      'attempts_exhausted',
    ]);
  });

  it('wipes payload at the original deadline without extending it', async () => {
    queueClaim({ deadline_at: new Date(Date.now() + 1) });
    fetchMock.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date(Date.now() + 100));
      return new Response('{}', { status: 503 });
    });
    await service.processOnce();
    expect(query.mock.calls[2][1]).toEqual([
      'job-id',
      'lease-id',
      'manual_required',
      null,
      'deadline_exceeded',
    ]);
  });

  it('wipes corrupt/old-client payload without network retries', async () => {
    queueClaim({ encrypted_payload: 'tampered' });
    await service.processOnce();
    expect(query.mock.calls[2][1]).toEqual([
      'job-id',
      'lease-id',
      'manual_required',
      null,
      'invalid_grant',
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes overlapping local polls and does not dispatch without a claim', async () => {
    let release!: (value: unknown[]) => void;
    query.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          release = resolve;
        }),
    );
    const first = service.processOnce();
    const second = service.processOnce();
    expect(first).toBe(second);
    release([]);
    await first;
    expect(query).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates refreshed tokens under the exact lease before allowing provider unlink', async () => {
    queueClaim();
    query.mockResolvedValueOnce([[{ id: 'job-id' }], 1]);
    jest
      .spyOn(client, 'revoke')
      .mockImplementationOnce(async (_grant, persist) => {
        await persist(grant('google', { accessToken: 'new-access' }));
      });
    await service.processOnce();
    const [sql, params] = query.mock.calls[2] as [string, string[]];
    expect(sql).toContain('lease_token = $2');
    expect(sql).toContain('deadline_at > now()');
    expect(decrypt(params[2]).accessToken).toBe('new-access');
    expect(JSON.stringify(params)).not.toContain('new-access');
    expect(query.mock.calls[3][1][2]).toBe('succeeded');
  });

  it('does not restore payloads when a refresh update loses the claim', async () => {
    queueClaim();
    jest
      .spyOn(client, 'revoke')
      .mockImplementationOnce(async (_grant, persist) => {
        await persist(grant('google'));
      });
    await service.processOnce();
    expect(query.mock.calls[3][1][2]).toBe('manual_required');
    expect(query.mock.calls[3][1][4]).toBe('lease_lost');
  });

  it('keeps encrypted target data retryable after a transient refresh persistence failure', async () => {
    queueClaim();
    query.mockRejectedValueOnce(new Error('database connection interrupted'));
    jest
      .spyOn(client, 'revoke')
      .mockImplementationOnce(async (_grant, persist) => {
        await persist(grant('google'));
      });
    await service.processOnce();
    expect(query.mock.calls[3][1][2]).toBe('retry');
    expect(query.mock.calls[3][1][4]).toBe('worker_unavailable');
  });

  it('lists bounded metadata only even if a repository returns extra encrypted/provider/account data', async () => {
    find.mockResolvedValueOnce([
      {
        id: 'job-id',
        status: 'manual_required',
        encryptedPayload: 'do-not-expose',
        subject: 'vendor-subject',
        accountId: 'account-id',
        leaseToken: 'lease-id',
        targetHash: 'private-target-hash',
      },
    ]);
    const rows = await service.list('manual_required', 500);
    expect(find.mock.calls[0][0]).toMatchObject({
      take: 100,
      where: { status: 'manual_required' },
    });
    expect(find.mock.calls[0][0].select).not.toContain('encryptedPayload');
    expect(find.mock.calls[0][0].select).not.toContain('targetHash');
    expect(JSON.stringify(rows)).not.toContain('private-target-hash');
    expect(JSON.stringify(rows)).not.toContain('do-not-expose');
    expect(JSON.stringify(rows)).not.toContain('vendor-subject');
    expect(JSON.stringify(rows)).not.toContain('account-id');
    expect(JSON.stringify(rows)).not.toContain('lease-id');
  });

  it('allows early retry only within remaining attempts/deadline and never resurrects erased data', async () => {
    query.mockResolvedValueOnce([[{ id: 'job-id' }], 1]);
    await expect(service.retry('job-id')).resolves.toBe(true);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('attempts < 8');
    expect(sql).toContain('deadline_at > now()');
    expect(sql).toContain("status IN ('pending', 'retry')");
    expect(sql).not.toContain('deadline_at =');
    await expect(service.retry('wiped-job')).resolves.toBe(false);
  });

  it('uses a stable namespaced HMAC of provider, client and subject, not the raw target or grant', async () => {
    const original = identity('google');
    await service.enqueue(manager, [original], 'unlink');
    await service.enqueue(
      manager,
      [
        {
          ...original,
          encryptedRevocationGrant: encrypt(
            grant('google', { accessToken: 'new-token' }),
          ),
        },
      ],
      'withdraw',
    );
    const first = (save.mock.calls[0][0] as ProviderRevocationJobEntity[])[0];
    const second = (save.mock.calls[1][0] as ProviderRevocationJobEntity[])[0];
    expect(first.targetHash).toBe(second.targetHash);
    expect(first.targetHash).toBe(targetHash(original));
    expect(first.targetHash).toMatch(/^[a-f0-9]{64}$/);
    for (const change of [
      { provider: 'naver' },
      { providerClientId: 'other-client' },
      { subject: 'other-subject' },
    ]) {
      query.mockClear();
      await service.assertConnectionAvailable(manager, {
        ...original,
        ...change,
      });
      expect(query.mock.calls[0][1][0]).not.toBe(first.targetHash);
    }
  });

  it.each(['pending', 'processing', 'retry'])(
    'blocks a matching %s job without contacting the provider or considering an expired lease',
    async (status) => {
      query.mockResolvedValueOnce([{ id: 'old-job', status }]);
      await expect(
        service.assertConnectionAvailable(manager, identity('google')),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'provider_connection_pending',
        }),
        status: 409,
      });
      const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("status IN ('pending', 'processing', 'retry')");
      expect(sql).toContain('target_hash = $1');
      expect(sql).not.toMatch(/deadline_at|lease_expires_at|next_attempt_at/);
      expect(parameters).toEqual([targetHash(identity('google'))]);
      expect(save).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('fails closed for legacy active rows with missing or empty target hashes', async () => {
    query.mockResolvedValueOnce([[{ id: 'legacy-job' }], 1]);
    await expect(
      service.assertConnectionAvailable(manager, identity('google')),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(query.mock.calls[0][0]).toContain(
      "target_hash IS NULL OR target_hash = ''",
    );
  });

  it('permits connection when no active matching target exists and requires the mutation transaction', async () => {
    await expect(
      service.assertConnectionAvailable(manager, identity('google')),
    ).resolves.toBeUndefined();
    await expect(
      service.assertConnectionAvailable(
        { queryRunner: { isTransactionActive: false } } as EntityManager,
        identity('google'),
      ),
    ).rejects.toThrow('account mutation transaction');
    expect(query).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps relinking fenced across a paused remote revoke and releases only after recording terminal completion', async () => {
    let status = 'pending';
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const rpc = new Promise<void>((resolve) => {
      release = resolve;
    });
    const linked = identity('google');
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT id FROM provider_revocation_jobs'))
        return ['pending', 'processing', 'retry'].includes(status)
          ? [{ id: 'job-id' }]
          : [];
      if (sql.includes('WITH candidate')) {
        status = 'processing';
        return [
          {
            id: 'job-id',
            encrypted_payload: encrypt(grant('google')),
            attempts: 1,
            deadline_at: new Date(Date.now() + DAY),
            lease_token: 'lease-id',
          },
        ];
      }
      if (sql.includes('SET status = $3')) status = 'succeeded';
      return [];
    });
    jest.spyOn(client, 'revoke').mockImplementationOnce(async () => {
      started();
      await rpc;
    });
    await expect(
      service.assertConnectionAvailable(manager, linked),
    ).rejects.toBeInstanceOf(ConflictException);
    const processing = service.processOnce();
    await entered;
    expect(status).toBe('processing');
    await expect(
      service.assertConnectionAvailable(manager, linked),
    ).rejects.toBeInstanceOf(ConflictException);
    release();
    await processing;
    expect(status).toBe('succeeded');
    await expect(
      service.assertConnectionAvailable(manager, linked),
    ).resolves.toBeUndefined();
  });

  it('disables automatic polling for tests, while allowing explicit processOnce', async () => {
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(query).not.toHaveBeenCalled();
    await service.processOnce();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('disables automatic polling via SOCIAL_REVOCATIONS_ENABLED=false', async () => {
    jest.replaceProperty(process.env, 'NODE_ENV', 'production');
    settings.set('NODE_ENV', 'production');
    settings.set('SOCIAL_REVOCATIONS_ENABLED', 'false');
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(query).not.toHaveBeenCalled();
  });

  it('polls by default and logs only a constant error without raw database/provider text', async () => {
    jest.replaceProperty(process.env, 'NODE_ENV', 'production');
    settings.set('NODE_ENV', 'production');
    const logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    query.mockRejectedValueOnce(new Error('private-access-token raw-subject'));
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(logger).toHaveBeenCalledWith('Provider revocation worker failed');
    await jest.advanceTimersByTimeAsync(5000);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('does not retain thrown provider error descriptions', async () => {
    queueClaim();
    jest
      .spyOn(client, 'revoke')
      .mockRejectedValueOnce(new ProviderRevocationError('provider_rejected'));
    await service.processOnce();
    expect(query.mock.calls[2][1][4]).toBe('provider_rejected');
  });

  function encrypt(value: ProviderRevocationGrant): string {
    return crypto.encrypt(JSON.stringify(value));
  }
  function targetHash(linked: SocialIdentityEntity): string {
    return createHmac('sha256', 'isolated-test-key')
      .update(
        JSON.stringify([
          'provider-revocation-target-v1',
          linked.provider,
          linked.providerClientId,
          linked.subject,
        ]),
      )
      .digest('hex');
  }
  function decrypt(value: string): ProviderRevocationGrant {
    return JSON.parse(crypto.decrypt(value)) as ProviderRevocationGrant;
  }
  function grant(
    provider: string,
    overrides: Partial<ProviderRevocationGrant> = {},
  ): ProviderRevocationGrant {
    return {
      provider,
      clientId: `${provider}-client`,
      subject: provider === 'kakao' ? '123' : 'vendor-subject',
      accessToken: 'private-access-token',
      refreshToken: 'private-refresh-token',
      accessTokenExpiresAt: Date.now() + 3_600_000,
      refreshTokenExpiresAt: null,
      ...overrides,
    };
  }
  function identity(
    provider: string,
    encrypted?: string | null,
  ): SocialIdentityEntity {
    return Object.assign(new SocialIdentityEntity(), {
      id: 'identity-id',
      accountId: 'account-id',
      provider,
      providerClientId: `${provider}-client`,
      subject: provider === 'kakao' ? '123' : 'vendor-subject',
      encryptedRevocationGrant:
        encrypted === undefined ? encrypt(grant(provider)) : encrypted,
    });
  }
  function queueClaim(overrides: Record<string, unknown> = {}): void {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([
      [
        {
          id: 'job-id',
          encrypted_payload: encrypt(grant('google')),
          attempts: 1,
          deadline_at: new Date(Date.now() + DAY),
          lease_token: 'lease-id',
          ...overrides,
        },
      ],
      1,
    ]);
  }
});
