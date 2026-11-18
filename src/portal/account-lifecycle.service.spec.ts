import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { AccountEntity } from '../database/entities/account.entity';
import { AdminSessionEntity } from '../database/entities/admin-session.entity';
import { SocialIdentityEntity } from '../database/entities/social-identity.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { AccountsService } from '../domain/accounts/accounts.service';
import { PermissionWebhooksService } from '../domain/permission-webhooks/permission-webhooks.service';
import { ProviderRevocationsService } from '../social/provider-revocations.service';
import {
  ProviderEventIdentitySnapshot,
  providerEventIdentitySnapshot,
} from '../social/provider-events/provider-event.types';
import { UnlinkProviderDto, WithdrawAccountDto } from './account-lifecycle.dto';
import {
  AccountLifecycleService,
  LAST_ACTIVE_SUPERADMIN_LOCK,
} from './account-lifecycle.service';
import { PORTAL_CLIENT_ID, PortalActor, RECENT_AUTH_MS } from './portal.types';

const NOW = new Date('2026-11-18T08:00:00.000Z');
const INPUT = { confirmation: 'UNLINK', currentPassword: 'Current-password!' };
const WITHDRAW = { ...INPUT, confirmation: 'DELETE' };

function setup(local = true, superadmin = false) {
  const account = Object.assign(new AccountEntity(), {
    id: 'c2c17c09-e9e2-4676-88a3-05ed94e78059',
    loginId: local ? 'login-id' : null,
    passwordHash: local ? 'password-hash' : null,
    email: 'person@example.test',
    name: 'Private Name',
    status: 'active',
    credentialVersion: 3,
    passwordResetRequired: false,
    isSuperAdmin: superadmin,
  });
  const session: TokenRecordEntity = Object.assign(new TokenRecordEntity(), {
    id: 'portal-id',
    accountId: account.id,
    tokenHash: 'portal-token-hash',
    clientId: PORTAL_CLIENT_ID,
    type: 'portal_session',
    status: 'active',
    expiresAt: new Date(NOW.getTime() + 60_000),
    metadataJson: {
      credentialVersion: account.credentialVersion,
      authenticatedAt: NOW.toISOString(),
      ...(superadmin ? { adminSessionId: 'admin-id' } : {}),
    },
  });
  const actor: PortalActor = {
    account: { ...account },
    session: { ...session, metadataJson: { ...session.metadataJson } },
    csrfToken: 'already-checked-by-controller',
  };
  const admin: AdminSessionEntity = Object.assign(new AdminSessionEntity(), {
    id: 'admin-id',
    accountId: account.id,
    revokedAt: null,
    credentialVersion: account.credentialVersion,
    idleExpiresAt: session.expiresAt,
    absoluteExpiresAt: session.expiresAt,
  });
  const identities: SocialIdentityEntity[] = [
    Object.assign(new SocialIdentityEntity(), {
      id: 'google-id',
      accountId: account.id,
      provider: 'google',
      providerClientId: 'client-id',
      subject: 'private-subject',
      encryptedRevocationGrant: 'encrypted-grant',
    }),
  ];
  const events: string[] = [];
  const audits: unknown[] = [];
  const onboardings: unknown[] = [];
  let returnedTransactions: unknown = [];
  const manager = {
    findOne: jest.fn(async (target: unknown) => {
      events.push(
        target === AccountEntity
          ? 'account-lock'
          : target === TokenRecordEntity
            ? 'portal-lock'
            : 'admin-lock',
      );
      return target === AccountEntity
        ? account
        : target === TokenRecordEntity
          ? session
          : target === AdminSessionEntity
            ? admin
            : null;
    }),
    find: jest.fn(async (target: unknown) =>
      target === SocialIdentityEntity
        ? identities
        : target === TokenRecordEntity
          ? [session]
          : [],
    ),
    countBy: jest.fn().mockResolvedValue(1),
    update: jest.fn(async () => {
      events.push('version');
    }),
    delete: jest.fn(async (target: unknown) => {
      events.push(
        target === AccountEntity ? 'delete-account' : 'delete-identity',
      );
    }),
    query: jest.fn(
      async (sql: string, _parameters?: unknown[]): Promise<unknown> => {
        void _parameters;
        if (sql.includes('pg_advisory')) events.push('global-lock');
        if (sql.includes('RETURNING data_json')) return returnedTransactions;
        if (sql.includes('FROM audit_logs')) return audits;
        if (sql.includes('FROM service_onboarding_requests'))
          return onboardings;
        return [];
      },
    ),
  };
  const accounts = {
    revokeAccountSessions: jest.fn(async () => {
      events.push('revoke');
    }),
  };
  const passwords = {
    verify: jest.fn().mockResolvedValue(true),
    hash: jest.fn(),
  };
  const revocations = {
    prepare: jest.fn((_rows: SocialIdentityEntity[]) => {
      void _rows;
      events.push('prepare');
    }),
    enqueue: jest.fn(
      async (
        _manager: EntityManager,
        rows: SocialIdentityEntity[],
        _reason: string,
      ) => {
        void _reason;
        events.push('enqueue');
        return rows.length;
      },
    ),
  };
  const webhooks = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const identityRepository = {
    findOneBy: jest.fn(async () => identities[0] ?? null),
  };
  const dataSource = {
    transaction: jest.fn(
      async (callback: (value: EntityManager) => Promise<unknown>) => {
        try {
          const result = await callback(manager as unknown as EntityManager);
          events.push('commit');
          return result;
        } catch (error) {
          events.push('rollback');
          throw error;
        }
      },
    ),
    getRepository: jest.fn(() => identityRepository),
  };
  const service = new AccountLifecycleService(
    dataSource as unknown as DataSource,
    accounts as unknown as AccountsService,
    passwords,
    revocations as unknown as ProviderRevocationsService,
    webhooks as unknown as PermissionWebhooksService,
  );
  return {
    service,
    account,
    actor,
    session,
    admin,
    identities,
    manager,
    accounts,
    passwords,
    revocations,
    webhooks,
    dataSource,
    identityRepository,
    events,
    audits,
    onboardings,
    setTransactions(value: unknown) {
      returnedTransactions = value;
    },
    unlink: () => service.unlink(actor, 'google', INPUT),
    withdraw: () => service.withdraw(actor, WITHDRAW),
    external: (
      kind: 'unlinked' | 'sessions_revoked' = 'unlinked',
      expectedSnapshot?: ProviderEventIdentitySnapshot | null,
    ) =>
      service.consumeProviderEvent(
        'google',
        'client-id',
        'private-subject',
        kind,
        expectedSnapshot,
      ),
  };
}

describe('AccountLifecycleService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it('validates DTO confirmation exactly, rejects null passwords and unowned input IDs', async () => {
    expect(
      await validate(plainToInstance(UnlinkProviderDto, INPUT)),
    ).toHaveLength(0);
    expect(
      await validate(plainToInstance(WithdrawAccountDto, WITHDRAW)),
    ).toHaveLength(0);
    for (const confirmation of ['unlink', ' UNLINK', 'UNLINK ', '', null])
      expect(
        await validate(plainToInstance(UnlinkProviderDto, { confirmation })),
      ).not.toHaveLength(0);
    expect(
      await validate(
        plainToInstance(WithdrawAccountDto, {
          ...WITHDRAW,
          currentPassword: null,
        }),
      ),
    ).not.toHaveLength(0);
    expect(
      await validate(
        plainToInstance(UnlinkProviderDto, { ...INPUT, accountId: 'other' }),
        {
          whitelist: true,
          forbidNonWhitelisted: true,
        },
      ),
    ).not.toHaveLength(0);
  });

  it('locks administration, account and portal before queueing/revoking/deleting', async () => {
    const f = setup();
    expect(await f.unlink()).toEqual({
      ok: true,
      reauthenticate: true,
      pendingProviderRevocations: 1,
    });
    expect(f.events).toEqual([
      'global-lock',
      'account-lock',
      'portal-lock',
      'prepare',
      'enqueue',
      'version',
      'revoke',
      'delete-identity',
      'commit',
    ]);
    expect(f.manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [LAST_ACTIVE_SUPERADMIN_LOCK],
    );
    expect(f.manager.findOne).toHaveBeenNthCalledWith(1, AccountEntity, {
      where: { id: f.account.id },
      lock: { mode: 'pessimistic_write' },
    });
    expect(f.accounts.revokeAccountSessions).toHaveBeenCalledWith(
      f.account.id,
      f.manager,
    );
    expect(f.manager.update).toHaveBeenCalledWith(AccountEntity, f.account.id, {
      credentialVersion: 4,
    });
    expect(f.revocations.enqueue).toHaveBeenCalledWith(
      f.manager,
      f.identities,
      'unlink',
    );
  });

  it.each(['google', 'kakao', 'naver'])(
    'supports unlinking %s without exposing a subject',
    async (provider) => {
      const f = setup();
      f.identities[0].provider = provider;
      expect(
        JSON.stringify(await f.service.unlink(f.actor, provider, INPUT)),
      ).not.toContain('private-subject');
    },
  );

  it('rejects invalid providers and confirmations before a transaction', async () => {
    const f = setup();
    await expect(
      f.service.unlink(f.actor, 'google', { ...INPUT, confirmation: 'DELETE' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.service.unlink(f.actor, 'other', INPUT),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.service.withdraw(f.actor, INPUT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(f.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('requires the locked account password, not a stale actor hash', async () => {
    const f = setup();
    f.actor.account.passwordHash = 'stale-hash';
    f.passwords.verify.mockResolvedValue(false);
    await expect(f.unlink()).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.passwords.verify).toHaveBeenCalledWith(
      'password-hash',
      INPUT.currentPassword,
    );
    expect(f.revocations.enqueue).not.toHaveBeenCalled();
  });

  it('requires current password for withdrawal and does not enqueue on failure', async () => {
    const f = setup();
    await expect(
      f.service.withdraw(f.actor, { confirmation: 'DELETE' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'invalid_current_password' }),
    });
    expect(f.manager.delete).not.toHaveBeenCalled();
    expect(f.revocations.prepare).not.toHaveBeenCalled();
  });

  it('protects all identities of the last provider as one login method', async () => {
    const f = setup(false);
    f.identities.push({
      ...f.identities[0],
      id: 'second-client',
      providerClientId: 'old-client',
    });
    await expect(f.unlink()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'last_login_method' }),
    });
    expect(f.revocations.prepare).not.toHaveBeenCalled();
  });

  it('allows a social-only account to remove one of multiple providers', async () => {
    const f = setup(false);
    f.identities.push({
      ...f.identities[0],
      id: 'kakao-id',
      provider: 'kakao',
    });
    await expect(f.unlink()).resolves.toMatchObject({ ok: true });
    expect(f.revocations.prepare).toHaveBeenCalledWith([f.identities[0]]);
    expect(f.passwords.verify).not.toHaveBeenCalled();
  });

  it('rejects unlink when no matching connection belongs to the account', async () => {
    const f = setup();
    f.identities.length = 0;
    await expect(f.unlink()).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    'active-version',
    'disabled',
    'reset-required',
    'session-owner',
    'session-status',
    'session-expired',
    'session-type',
    'session-client',
    'session-version',
    'session-hash',
    'actor-owner',
  ])('rejects stale or unowned state: %s', async (scenario) => {
    const f = setup();
    if (scenario === 'active-version') f.account.credentialVersion++;
    if (scenario === 'disabled') f.account.status = 'disabled';
    if (scenario === 'reset-required') f.account.passwordResetRequired = true;
    if (scenario === 'session-owner') f.session.accountId = 'another-account';
    if (scenario === 'session-status') f.session.status = 'revoked';
    if (scenario === 'session-expired') f.session.expiresAt = NOW;
    if (scenario === 'session-type') f.session.type = 'sso_session';
    if (scenario === 'session-client') f.session.clientId = 'other-client';
    if (scenario === 'session-version')
      f.session.metadataJson!.credentialVersion = 9;
    if (scenario === 'session-hash') f.session.tokenHash = 'different-browser';
    if (scenario === 'actor-owner')
      f.actor.session.accountId = 'another-account';
    await expect(f.unlink()).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.revocations.enqueue).not.toHaveBeenCalled();
    expect(f.manager.delete).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    'invalid',
    new Date(NOW.getTime() + 1).toISOString(),
    new Date(NOW.getTime() - RECENT_AUTH_MS - 1).toISOString(),
  ])(
    'requires a real recent DB authentication timestamp: %s',
    async (stamp) => {
      const f = setup();
      f.session.metadataJson!.authenticatedAt = stamp;
      f.actor.session.metadataJson!.authenticatedAt = NOW.toISOString();
      await expect(f.unlink()).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.revocations.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([
    'revoked',
    'idle-expired',
    'absolute-expired',
    'wrong-owner',
    'wrong-version',
    'missing-binding',
  ])('revalidates OTP admin session under a lock: %s', async (scenario) => {
    const f = setup(true, true);
    if (scenario === 'revoked') f.admin.revokedAt = NOW;
    if (scenario === 'idle-expired') f.admin.idleExpiresAt = NOW;
    if (scenario === 'absolute-expired') f.admin.absoluteExpiresAt = NOW;
    if (scenario === 'wrong-owner') f.admin.accountId = 'another-account';
    if (scenario === 'wrong-version') f.admin.credentialVersion++;
    if (scenario === 'missing-binding')
      delete f.session.metadataJson!.adminSessionId;
    await expect(f.withdraw()).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.revocations.enqueue).not.toHaveBeenCalled();
  });

  it('prevents the last active superadmin from withdrawing', async () => {
    const f = setup(true, true);
    await expect(f.withdraw()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'last_active_superadmin' }),
    });
    expect(f.revocations.prepare).not.toHaveBeenCalled();
    expect(f.manager.delete).not.toHaveBeenCalled();
  });

  it('queues withdrawal targets before cleaning Auth-owned data', async () => {
    const f = setup(true, true);
    f.manager.countBy.mockResolvedValue(2);
    expect(await f.withdraw()).toEqual({
      withdrawn: true,
      pendingProviderRevocations: 1,
    });
    expect(f.events.indexOf('enqueue')).toBeLessThan(
      f.events.indexOf('revoke'),
    );
    expect(f.events.at(-2)).toBe('delete-account');
    expect(f.manager.delete).toHaveBeenCalledWith(AccountEntity, {
      id: f.account.id,
    });
    const queries = f.manager.query.mock.calls.map(([sql]) => sql).join('\n');
    expect(queries).toContain('DELETE FROM token_records');
    expect(queries).toContain(
      'DELETE FROM service_applications WHERE account_id = $1',
    );
    expect(queries).toContain(
      'UPDATE account_service_permissions SET granted_by_account_id = NULL',
    );
    expect(queries).not.toMatch(
      /DELETE FROM (services|oidc_clients|service_credentials|service_onboarding_requests|audit_logs)\b/,
    );
  });

  it('uses existing permission.updated revocations, never a new wire event', async () => {
    const f = setup();
    const original = f.manager.find.getMockImplementation()!;
    f.manager.find.mockImplementation(async (target) =>
      target === AccountServicePermissionEntity
        ? ([
            {
              serviceId: 'service-id',
              service: { serviceKey: 'game' },
              permissionDefinition: { key: 'member' },
            },
          ] as never)
        : original(target),
    );
    await f.withdraw();
    expect(f.webhooks.enqueue).toHaveBeenCalledWith(
      f.manager,
      'service-id',
      expect.objectContaining({
        type: 'permission.updated',
        accountId: f.account.id,
        data: {
          permission: null,
          previousPermission: 'member',
          status: 'revoked',
          reason: 'revoked',
        },
      }),
    );
  });

  it.each(['prepare', 'enqueue'])(
    'does not delete or revoke after provider %s failure',
    async (stage) => {
      const f = setup();
      if (stage === 'prepare')
        f.revocations.prepare.mockImplementation(() => {
          throw new ConflictException({
            code: 'provider_reauthentication_required',
          });
        });
      else
        f.revocations.enqueue.mockRejectedValue(
          new Error('database unavailable'),
        );
      await expect(f.withdraw()).rejects.toThrow();
      expect(f.manager.delete).not.toHaveBeenCalled();
      expect(f.accounts.revokeAccountSessions).not.toHaveBeenCalled();
      expect(f.events.at(-1)).toBe('rollback');
    },
  );

  it('accepts Postgres DELETE RETURNING envelopes and removes pending verification proofs', async () => {
    const f = setup();
    f.setTransactions([
      [{ data_json: { emailVerificationId: 'verification-id' } }],
      1,
    ]);
    await f.withdraw();
    const call = f.manager.query.mock.calls.find(([sql]) =>
      sql.includes('DELETE FROM email_verifications'),
    )!;
    expect(call[1]?.[1]).toEqual(['verification-id']);
    expect(call[1]?.[2]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
  });

  it.each(['withdrawal', 'provider-unlink'])(
    'casts UUID account parameters at text uses during %s erasure',
    async (path) => {
      const f = setup(path === 'withdrawal');
      if (path === 'withdrawal') await f.withdraw();
      else await f.external();
      const queries = f.manager.query.mock.calls;
      const audits = queries.find(([sql]) => sql.includes('FROM audit_logs'))!;
      const onboarding = queries.find(([sql]) =>
        sql.includes('FROM service_onboarding_requests'),
      )!;
      const tokens = queries.find(([sql]) =>
        sql.includes('DELETE FROM token_records'),
      )!;
      expect(audits[0]).toContain(
        "COALESCE(after_json::text, ''), $1::text) > 0",
      );
      expect(onboarding[0]).toContain('WHERE decided_by_account_id = $1');
      expect(onboarding[0]).toContain(
        "COALESCE(approved_snapshot_json::text, ''), $1::text) > 0",
      );
      expect(tokens[0]).toContain('WHERE account_id = $1');
      expect(tokens[0]).toContain(
        "metadata_json->>'expectedAccountId' = $1::text",
      );
      expect(audits[1]?.[0]).toBe(f.account.id);
      expect(onboarding[1]?.[0]).toBe(f.account.id);
      expect(tokens[1]).toEqual([f.account.id]);
    },
  );

  it('anonymizes audit/onboarding data while preserving business spec and unrelated profile fields', async () => {
    const f = setup();
    f.audits.push({
      id: 'audit',
      actorAccountId: f.account.id,
      targetType: 'service',
      targetId: 'service-id',
      beforeJson: null,
      afterJson: {
        accountId: f.account.id,
        email: f.account.email,
        otherEmail: 'another@example.test',
        serviceKey: 'retained-service',
      },
    });
    f.onboardings.push({
      id: 'onboarding',
      requesterEmail: f.account.email,
      decidedByAccountId: f.account.id,
      requestedSpecJson: {
        serviceKey: 'retained-service',
        requesterName: 'Old Personal Name',
        requesterEmail: f.account.email,
      },
      approvedSnapshotJson: null,
      decisionReason: `Email ${f.account.email}`,
    });
    await f.withdraw();
    const audit = f.manager.query.mock.calls.find(([sql]) =>
      sql.startsWith('UPDATE audit_logs'),
    )!;
    expect(JSON.parse(audit[1]?.[3] as string)).toEqual({
      accountId: null,
      email: null,
      otherEmail: 'another@example.test',
      serviceKey: 'retained-service',
    });
    const onboarding = f.manager.query.mock.calls.find(([sql]) =>
      sql.startsWith('UPDATE service_onboarding_requests'),
    )!;
    expect(onboarding[1]?.[2]).toBe(true);
    expect(JSON.parse(onboarding[1]?.[3] as string)).toEqual({
      serviceKey: 'retained-service',
    });
    expect(onboarding[1]?.[5]).toBe('Email [withdrawn]');
    expect(onboarding[0]).not.toContain('request_secret_hash');
  });

  it('overview exposes only safe aggregated controls and does not require recent auth', async () => {
    const f = setup(false);
    f.session.metadataJson!.authenticatedAt = 'old-or-missing';
    const overview = await f.service.overview(f.actor);
    expect(overview).toEqual({
      accountDeletion: {
        allowed: true,
        blockedReason: null,
        serviceDataPolicy: 'separate',
      },
      connections: [
        {
          provider: 'google',
          identityCount: 1,
          canUnlink: false,
          reason: 'last_login_method',
          requiresProviderAuthentication: false,
        },
      ],
    });
    expect(JSON.stringify(overview)).not.toMatch(
      /private-subject|encrypted-grant|token|client-id/,
    );
    expect(f.manager.update).not.toHaveBeenCalled();
    expect(f.manager.delete).not.toHaveBeenCalled();
    expect(f.revocations.enqueue).not.toHaveBeenCalled();
  });

  it('overview reports known provider reauthentication and configuration blockers', async () => {
    const f = setup();
    f.revocations.prepare.mockImplementation(() => {
      throw new ConflictException({
        code: 'provider_reauthentication_required',
      });
    });
    expect((await f.service.overview(f.actor)).connections[0]).toMatchObject({
      canUnlink: false,
      reason: 'provider_reauthentication_required',
      requiresProviderAuthentication: true,
    });
    f.revocations.prepare.mockImplementation(() => {
      throw new ServiceUnavailableException('provider_not_configured');
    });
    expect((await f.service.overview(f.actor)).accountDeletion).toMatchObject({
      allowed: false,
      blockedReason: 'provider_revocation_unavailable',
    });
    f.revocations.prepare.mockImplementation(() => {
      throw new Error('unexpected crypto bug');
    });
    await expect(f.service.overview(f.actor)).rejects.toThrow(
      'unexpected crypto bug',
    );
  });

  it('overview shows the last-admin withdrawal blocker', async () => {
    const f = setup(true, true);
    expect(
      (await f.service.overview(f.actor)).accountDeletion.blockedReason,
    ).toBe('last_active_superadmin');
  });

  it('does not disguise unexpected provider conflicts as overview blockers', async () => {
    const f = setup();
    const failure = new ConflictException({
      code: 'unexpected_integrity_failure',
    });
    f.revocations.prepare.mockImplementation(() => {
      throw failure;
    });
    await expect(f.service.overview(f.actor)).rejects.toBe(failure);
  });

  it('erases personal resource audit snapshots, including device names unrelated to the account name', async () => {
    const f = setup();
    const original = f.manager.query.getMockImplementation()!;
    f.manager.query.mockImplementation(async (sql, parameters) =>
      sql.includes('UNION ALL SELECT id::text FROM notification_devices')
        ? [{ id: 'owned-device' }]
        : original(sql, parameters),
    );
    f.audits.push({
      id: 'device-audit',
      actorAccountId: f.account.id,
      targetType: 'notification_device',
      targetId: 'owned-device',
      beforeJson: null,
      afterJson: {
        displayName: 'Private device nickname',
        installationId: 'private-installation',
      },
    });
    await f.withdraw();
    const update = f.manager.query.mock.calls.find(([sql]) =>
      sql.startsWith('UPDATE audit_logs'),
    )!;
    expect(update[1]?.[2]).toBeNull();
    expect(update[1]?.[3]).toBeNull();
    expect(update[1]?.[4]).toContain('owned-device');
  });

  it('ignores unknown authenticated provider tuples and never uses email to identify them', async () => {
    const f = setup();
    f.identityRepository.findOneBy.mockResolvedValue(null as never);
    await f.external();
    expect(f.identityRepository.findOneBy).toHaveBeenCalledWith({
      provider: 'google',
      providerClientId: 'client-id',
      subject: 'private-subject',
    });
    expect(f.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('external unlink of a sole social login hard-deletes Auth without queueing an already-revoked grant', async () => {
    const f = setup(false);
    f.revocations.prepare.mockImplementation(() => {
      throw new Error('must not run');
    });
    await f.external();
    expect(f.manager.delete).toHaveBeenCalledWith(AccountEntity, {
      id: f.account.id,
    });
    expect(f.revocations.enqueue).not.toHaveBeenCalled();
  });

  it('external unlink with local credentials removes only the exact identity and revokes Auth sessions', async () => {
    const f = setup();
    await f.external();
    expect(f.manager.delete).toHaveBeenCalledWith(SocialIdentityEntity, {
      id: 'google-id',
      accountId: f.account.id,
    });
    expect(f.manager.delete).not.toHaveBeenCalledWith(
      AccountEntity,
      expect.anything(),
    );
    expect(f.accounts.revokeAccountSessions).toHaveBeenCalled();
    expect(f.revocations.enqueue).not.toHaveBeenCalled();
  });

  it('sessions_revoked never deletes an account or identity, even for a sole social login', async () => {
    const f = setup(false);
    await f.external('sessions_revoked');
    expect(f.manager.delete).not.toHaveBeenCalled();
    expect(f.accounts.revokeAccountSessions).toHaveBeenCalled();
  });

  it('commits fail-closed last-admin session revocation before reporting manual recovery', async () => {
    const f = setup(false, true);
    await expect(f.external()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'last_active_superadmin' }),
    });
    expect(f.events.at(-1)).toBe('commit');
    expect(f.accounts.revokeAccountSessions).toHaveBeenCalled();
    expect(f.manager.delete).not.toHaveBeenCalled();
    expect(f.manager.update).toHaveBeenCalledWith(
      SocialIdentityEntity,
      'google-id',
      {
        encryptedRevocationGrant: null,
      },
    );
    expect(f.account.status).toBe('active');
  });

  it('rechecks the identity after locking its account to make repeated unlink events a no-op', async () => {
    const f = setup(false);
    f.manager.find.mockResolvedValue([]);
    await f.external();
    expect(f.accounts.revokeAccountSessions).not.toHaveBeenCalled();
    expect(f.manager.delete).not.toHaveBeenCalled();
  });

  it.each(['unlinked', 'sessions_revoked'] as const)(
    'ignores queued %s receipts observed before any identity existed',
    async (kind) => {
      const f = setup(false);
      await f.external(kind, null);
      expect(f.dataSource.transaction).not.toHaveBeenCalled();
      expect(f.accounts.revokeAccountSessions).not.toHaveBeenCalled();
      expect(f.manager.update).not.toHaveBeenCalled();
      expect(f.manager.delete).not.toHaveBeenCalled();
    },
  );

  it.each(['unlinked', 'sessions_revoked'] as const)(
    'ignores a queued %s receipt after relinking the same tuple with a new identity ID',
    async (kind) => {
      const f = setup(false);
      const snapshot = providerEventIdentitySnapshot(f.identities[0]);
      f.identities[0] = { ...f.identities[0], id: 'new-identity-id' };
      await f.external(kind, snapshot);
      expect(f.accounts.revokeAccountSessions).not.toHaveBeenCalled();
      expect(f.manager.update).not.toHaveBeenCalled();
      expect(f.manager.delete).not.toHaveBeenCalled();
      expect(f.events).toContain('global-lock');
    },
  );

  it.each(['unlinked', 'sessions_revoked'] as const)(
    'ignores a queued %s receipt when the same identity has a newer encrypted grant',
    async (kind) => {
      const f = setup(false);
      const snapshot = providerEventIdentitySnapshot(f.identities[0]);
      f.identities[0].encryptedRevocationGrant = 'fresh-encrypted-proof';
      await f.external(kind, snapshot);
      expect(f.accounts.revokeAccountSessions).not.toHaveBeenCalled();
      expect(f.manager.update).not.toHaveBeenCalled();
      expect(f.manager.delete).not.toHaveBeenCalled();
      expect(f.revocations.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each(['identity', 'grant'])(
    'rechecks the captured %s generation after waiting for the lifecycle mutex',
    async (change) => {
      const f = setup(false);
      const snapshot = providerEventIdentitySnapshot(f.identities[0]);
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const mutex = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = f.manager.query.getMockImplementation()!;
      f.manager.query.mockImplementation(async (sql, parameters) => {
        if (sql.includes('pg_advisory')) {
          started();
          await mutex;
        }
        return original(sql, parameters);
      });
      const pending = f.external('unlinked', snapshot);
      await entered;
      expect(f.manager.update).not.toHaveBeenCalled();
      if (change === 'identity')
        f.identities[0] = { ...f.identities[0], id: 'new-identity-id' };
      else f.identities[0].encryptedRevocationGrant = 'fresh-encrypted-proof';
      release();
      await pending;
      expect(f.accounts.revokeAccountSessions).not.toHaveBeenCalled();
      expect(f.manager.delete).not.toHaveBeenCalled();
      expect(f.events.at(-1)).toBe('commit');
    },
  );

  it.each([null, 'encrypted-grant'])(
    'still processes the exact captured identity and grant %j',
    async (grant) => {
      const f = setup();
      f.identities[0].encryptedRevocationGrant = grant;
      await f.external(
        'unlinked',
        providerEventIdentitySnapshot(f.identities[0]),
      );
      expect(f.accounts.revokeAccountSessions).toHaveBeenCalledTimes(1);
      expect(f.manager.delete).toHaveBeenCalledWith(SocialIdentityEntity, {
        id: 'google-id',
        accountId: f.account.id,
      });
    },
  );
});
