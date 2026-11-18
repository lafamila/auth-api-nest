import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DataSource, IsNull } from 'typeorm';
import { AesGcmService } from '../src/common/crypto/aes-gcm.service';
import { PasswordService } from '../src/common/crypto/password.service';
import { hashToken } from '../src/common/crypto/token-hash';
import { AppConfigService } from '../src/config/app-config.service';
import { AUTH_ENTITIES } from '../src/database/database.module';
import { AccountPolicyConsentEntity } from '../src/database/entities/account-policy-consent.entity';
import { AccountServicePermissionEntity } from '../src/database/entities/account-service-permission.entity';
import { AccountEntity } from '../src/database/entities/account.entity';
import { AdminSessionEntity } from '../src/database/entities/admin-session.entity';
import { AuditLogEntity } from '../src/database/entities/audit-log.entity';
import { ProviderRevocationJobEntity } from '../src/database/entities/provider-revocation-job.entity';
import { ServiceApplicationEntity } from '../src/database/entities/service-application.entity';
import { ServiceOnboardingRequestEntity } from '../src/database/entities/service-onboarding-request.entity';
import { ServicePermissionDefinitionEntity } from '../src/database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../src/database/entities/service.entity';
import { SocialIdentityEntity } from '../src/database/entities/social-identity.entity';
import { TokenRecordEntity } from '../src/database/entities/token-record.entity';
import { AccountsService } from '../src/domain/accounts/accounts.service';
import { AuditLogsService } from '../src/domain/audit-logs/audit-logs.service';
import { PermissionWebhooksService } from '../src/domain/permission-webhooks/permission-webhooks.service';
import { AccountLifecycleService } from '../src/portal/account-lifecycle.service';
import { PORTAL_CLIENT_ID, PortalActor } from '../src/portal/portal.types';
import { ProviderRevocationsClient } from '../src/social/provider-revocations.client';
import { ProviderRevocationsService } from '../src/social/provider-revocations.service';

const isolated = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const CLIENT_ID = 'lifecycle-google-client';
const PASSWORD = 'Lifecycle-test-password!';
const DELETE = { confirmation: 'DELETE', currentPassword: PASSWORD };
const UNLINK = { confirmation: 'UNLINK', currentPassword: PASSWORD };

// No fallback to DATABASE_URL; even query-string database/search-path overrides
// are rejected before constructing a connection or touching disposable schemas.
function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('Explicit TEST_DATABASE_URL is required');
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !/^auth_portal_e2e(?:_[a-z0-9_]+)?$/.test(
      decodeURIComponent(url.pathname.slice(1)),
    ) ||
    [...url.searchParams.keys()].some((key) =>
      ['database', 'dbname', 'options', 'schema', 'search_path'].includes(
        key.toLowerCase(),
      ),
    )
  )
    throw new Error(
      'Lifecycle integration tests require auth_portal_e2e without database or search-path overrides',
    );
  return value;
}

jest.setTimeout(30_000);

isolated('Account lifecycle (disposable schema in auth_portal_e2e)', () => {
  const schema = `auth_lifecycle_${randomUUID().replaceAll('-', '')}`;
  let database: DataSource;
  let provisioning: DataSource;
  let service: AccountLifecycleService;
  let revocations: ProviderRevocationsService;
  let passwords: PasswordService;
  let crypto: AesGcmService;
  let schemaCreated = false;

  beforeAll(async () => {
    const url = testDatabaseUrl();
    provisioning = new DataSource({ type: 'postgres', url });
    await provisioning.initialize();
    await provisioning.query(
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public',
    );
    await provisioning.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    database = new DataSource({
      type: 'postgres',
      url,
      schema,
      extra: { options: `-c search_path=${schema},public` },
      entities: [
        ...new Set([
          ...AUTH_ENTITIES,
          AccountPolicyConsentEntity,
          ProviderRevocationJobEntity,
        ]),
      ],
      migrations: [join(__dirname, '../src/database/migrations/*.ts')],
      synchronize: false,
    });
    await database.initialize();
    await database.runMigrations();
    const settings = new ConfigService({
      NODE_ENV: 'test',
      ADMIN_OTP_ENCRYPTION_KEY: 'lifecycle-isolated-test-key',
      SOCIAL_GOOGLE_CLIENT_ID: CLIENT_ID,
      SOCIAL_NAVER_CLIENT_ID: 'lifecycle-naver-client',
      SOCIAL_NAVER_CLIENT_SECRET: 'lifecycle-naver-secret',
      PERMISSION_WEBHOOKS_ENABLED: 'true',
      SOCIAL_REVOCATIONS_ENABLED: 'false',
    });
    const config = new AppConfigService(settings);
    crypto = new AesGcmService(config);
    passwords = new PasswordService();
    const accounts = new AccountsService(
      database.getRepository(AccountEntity),
      database,
      passwords,
      new AuditLogsService(database.getRepository(AuditLogEntity)),
      database.getRepository(TokenRecordEntity),
    );
    revocations = new ProviderRevocationsService(
      database,
      settings,
      crypto,
      new ProviderRevocationsClient(settings),
    );
    const webhooks = new PermissionWebhooksService(
      database.getRepository('PermissionWebhookSubscriptionEntity'),
      database.getRepository('PermissionWebhookOutboxEntity'),
      config,
      crypto,
    );
    service = new AccountLifecycleService(
      database,
      accounts,
      passwords,
      revocations,
      webhooks,
    );
  });

  beforeEach(async () => {
    // Only this newly-created schema is emptied; no shared test or live rows.
    const tables = database.entityMetadatas.map(
      (metadata) => `"${schema}".${database.driver.escape(metadata.tableName)}`,
    );
    await database.query(`TRUNCATE ${tables.join(', ')} CASCADE`);
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(
        new Error('External HTTP must not run in lifecycle transactions'),
      );
  });

  afterEach(() => {
    expect(global.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (database?.isInitialized) await database.destroy();
    if (provisioning?.isInitialized) {
      if (schemaCreated)
        await provisioning.query(`DROP SCHEMA "${schema}" CASCADE`);
      await provisioning.destroy();
    }
  });

  it('provides safe overview and atomically queues unlink before invalidating every Auth family', async () => {
    const actor = await account();
    const google = await identity(actor.account.id);
    await identity(actor.account.id, 'naver');
    await tokens(actor.account);
    const overview = await service.overview(actor);
    expect(overview.connections).toHaveLength(2);
    expect(overview.accountDeletion).toEqual({
      allowed: true,
      blockedReason: null,
      serviceDataPolicy: 'separate',
    });
    expect(JSON.stringify(overview)).not.toContain(google.subject);
    expect(JSON.stringify(overview)).not.toContain(
      google.encryptedRevocationGrant,
    );
    expect(await service.unlink(actor, 'google', UNLINK)).toEqual({
      ok: true,
      reauthenticate: true,
      pendingProviderRevocations: 1,
    });
    expect(
      await database
        .getRepository(SocialIdentityEntity)
        .countBy({ accountId: actor.account.id }),
    ).toBe(1);
    expect(
      await database
        .getRepository(TokenRecordEntity)
        .countBy({ accountId: actor.account.id, status: 'active' }),
    ).toBe(0);
    const current = await database
      .getRepository(AccountEntity)
      .findOneByOrFail({ id: actor.account.id });
    expect(current.credentialVersion).toBe(actor.account.credentialVersion + 1);
    const jobs = await database
      .getRepository(ProviderRevocationJobEntity)
      .createQueryBuilder('job')
      .addSelect('job.encryptedPayload')
      .getMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].encryptedPayload).not.toContain(google.subject);
    expect(jobs[0].deadlineAt.getTime() - jobs[0].createdAt.getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it('rolls back persisted jobs as well as account changes when enqueue fails', async () => {
    const actor = await account();
    await identity(actor.account.id);
    const enqueue: ProviderRevocationsService['enqueue'] =
      revocations.enqueue.bind(revocations);
    jest
      .spyOn(revocations, 'enqueue')
      .mockImplementationOnce(async (...args) => {
        await enqueue(...args);
        throw new Error('Simulated failure after insert');
      });
    await expect(service.withdraw(actor, DELETE)).rejects.toThrow(
      'Simulated failure',
    );
    expect(
      await database.getRepository(ProviderRevocationJobEntity).count(),
    ).toBe(0);
    expect(await database.getRepository(SocialIdentityEntity).count()).toBe(1);
    expect(
      await database
        .getRepository(TokenRecordEntity)
        .countBy({ accountId: actor.account.id, status: 'active' }),
    ).toBe(1);
    expect(
      (
        await database
          .getRepository(AccountEntity)
          .findOneByOrFail({ id: actor.account.id })
      ).credentialVersion,
    ).toBe(0);
  });

  it('hard-deletes only Auth ownership, cascades consents/notifications, and anonymizes retained records', async () => {
    const actor = await account();
    const other = await account();
    await identity(actor.account.id);
    await tokens(actor.account);
    const business = await seedBusiness(actor, other);
    expect(await service.withdraw(actor, DELETE)).toEqual({
      withdrawn: true,
      pendingProviderRevocations: 1,
    });
    expect(
      await database
        .getRepository(AccountEntity)
        .findOneBy({ id: actor.account.id }),
    ).toBeNull();
    expect(
      await database
        .getRepository(AccountEntity)
        .findOneBy({ id: other.account.id }),
    ).not.toBeNull();
    expect(
      await database
        .getRepository(ServiceEntity)
        .countBy({ id: business.service.id }),
    ).toBe(1);
    expect(
      await database.getRepository(ServicePermissionDefinitionEntity).count(),
    ).toBe(1);
    expect(
      await database
        .getRepository(AccountServicePermissionEntity)
        .countBy({ accountId: other.account.id }),
    ).toBe(1);
    expect(
      await database
        .getRepository(ServiceApplicationEntity)
        .countBy({ accountId: other.account.id }),
    ).toBe(1);
    expect(
      (
        await database
          .getRepository(ServiceApplicationEntity)
          .findOneByOrFail({ id: business.otherApplication.id })
      ).reviewedByAccountId,
    ).toBeNull();
    expect(
      await database
        .getRepository(AccountPolicyConsentEntity)
        .countBy({ accountId: actor.account.id }),
    ).toBe(0);
    expect(
      await database
        .getRepository(TokenRecordEntity)
        .countBy({ accountId: actor.account.id }),
    ).toBe(0);
    const audit = await database
      .getRepository(AuditLogEntity)
      .findOneByOrFail({ id: business.audit.id });
    expect(audit.actorAccountId).toBeNull();
    expect(audit.afterJson).toEqual({
      serviceKey: business.service.serviceKey,
      accountId: null,
      email: null,
    });
    const onboarding = await database
      .getRepository(ServiceOnboardingRequestEntity)
      .findOneByOrFail({ id: business.onboarding.id });
    expect(onboarding.requesterName).toBeNull();
    expect(onboarding.requesterEmail).toBeNull();
    expect(onboarding.decidedByAccountId).toBeNull();
    expect(onboarding.requestedSpecJson.serviceKey).toBe(
      business.service.serviceKey,
    );
    expect(JSON.stringify(onboarding)).not.toContain(actor.account.email);
    for (const table of [
      'social_identities',
      'admin_sessions',
      'notification_devices',
      'notification_subscriptions',
      'notifications',
    ]) {
      const rows: Array<{ count: number }> = await database.query(
        `SELECT count(*)::integer AS count FROM ${table} WHERE account_id = $1`,
        [actor.account.id],
      );
      expect(rows[0].count).toBe(0);
    }
    const outbox: Array<{ event_json: Record<string, unknown> }> =
      await database.query('SELECT event_json FROM permission_webhook_outbox');
    expect(outbox).toHaveLength(1);
    expect(outbox[0].event_json).toMatchObject({
      type: 'permission.updated',
      accountId: actor.account.id,
      data: { status: 'revoked', reason: 'revoked' },
    });
  });

  it('rejects stale, revoked, and no-longer-owned portal actors using current locked DB state', async () => {
    const actor = await account();
    await identity(actor.account.id);
    await database
      .getRepository(TokenRecordEntity)
      .update(actor.session.id, { status: 'revoked' });
    await expect(
      service.unlink(actor, 'google', UNLINK),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(
      await database.getRepository(ProviderRevocationJobEntity).count(),
    ).toBe(0);
    expect(await database.getRepository(SocialIdentityEntity).count()).toBe(1);
  });

  it('blocks self-unlink of the last login method but permits explicit Auth withdrawal', async () => {
    const actor = await account(false);
    await identity(actor.account.id);
    await expect(
      service.unlink(actor, 'google', { confirmation: 'UNLINK' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.withdraw(actor, { confirmation: 'DELETE' }),
    ).resolves.toMatchObject({ withdrawn: true });
  });

  it('handles external session revocation without deleting, and sole-method unlink with Auth-only deletion', async () => {
    const actor = await account(false);
    const connection = await identity(actor.account.id);
    await service.consumeProviderEvent(
      'google',
      CLIENT_ID,
      connection.subject,
      'sessions_revoked',
    );
    expect(
      await database
        .getRepository(AccountEntity)
        .countBy({ id: actor.account.id }),
    ).toBe(1);
    expect(await database.getRepository(SocialIdentityEntity).count()).toBe(1);
    await service.consumeProviderEvent(
      'google',
      CLIENT_ID,
      connection.subject,
      'unlinked',
    );
    await service.consumeProviderEvent(
      'google',
      CLIENT_ID,
      connection.subject,
      'unlinked',
    );
    expect(
      await database
        .getRepository(AccountEntity)
        .countBy({ id: actor.account.id }),
    ).toBe(0);
    expect(
      await database.getRepository(ProviderRevocationJobEntity).count(),
    ).toBe(0);
  });

  it('keeps exactly one active superadmin under concurrent withdrawals', async () => {
    const first = await account(true, true);
    const second = await account(true, true);
    const results = await Promise.allSettled([
      service.withdraw(first, DELETE),
      service.withdraw(second, DELETE),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await database
        .getRepository(AccountEntity)
        .countBy({ isSuperAdmin: true, status: 'active' }),
    ).toBe(1);
  });

  it('retains the last externally-unlinked superadmin and commits session revocation, keeping bootstrap closed', async () => {
    const actor = await account(false, true);
    const connection = await identity(actor.account.id);
    await expect(
      service.consumeProviderEvent(
        'google',
        CLIENT_ID,
        connection.subject,
        'unlinked',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      await database
        .getRepository(AccountEntity)
        .countBy({ isSuperAdmin: true, status: 'active' }),
    ).toBe(1);
    expect(
      await database
        .getRepository(TokenRecordEntity)
        .countBy({ accountId: actor.account.id, status: 'active' }),
    ).toBe(0);
    expect(
      await database
        .getRepository(AdminSessionEntity)
        .countBy({ accountId: actor.account.id, revokedAt: IsNull() }),
    ).toBe(0);
  });

  async function account(
    local = true,
    superadmin = false,
  ): Promise<PortalActor> {
    const id = randomUUID();
    const saved = await database.getRepository(AccountEntity).save({
      id,
      loginId: local ? `lifecycle-${id}` : null,
      passwordHash: local ? await passwords.hash(PASSWORD) : null,
      name: `Lifecycle ${id}`,
      email: `${id}@example.test`,
      isSuperAdmin: superadmin,
      status: 'active',
      credentialVersion: 0,
      passwordResetRequired: false,
      emailVerifiedAt: new Date(),
    });
    let adminSessionId: string | undefined;
    if (superadmin) {
      const admin = await database.getRepository(AdminSessionEntity).save({
        accountId: saved.id,
        credentialVersion: 0,
        tokenHash: hashToken(randomBytes(32).toString('base64url')),
        idleExpiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() + 60_000),
        lastSeenAt: new Date(),
        revokedAt: null,
      });
      adminSessionId = admin.id;
    }
    const session = await database.getRepository(TokenRecordEntity).save({
      accountId: saved.id,
      clientId: PORTAL_CLIENT_ID,
      type: 'portal_session',
      status: 'active',
      tokenHash: hashToken(randomBytes(32).toString('base64url')),
      familyId: null,
      serviceId: null,
      metadataJson: {
        credentialVersion: 0,
        authenticatedAt: new Date().toISOString(),
        ...(adminSessionId ? { adminSessionId } : {}),
      },
      expiresAt: new Date(Date.now() + 60_000),
    });
    return { account: saved, session, csrfToken: 'controller-owns-csrf' };
  }

  async function identity(accountId: string, provider = 'google') {
    const subject = randomUUID();
    const clientId =
      provider === 'google' ? CLIENT_ID : 'lifecycle-naver-client';
    return database.getRepository(SocialIdentityEntity).save({
      accountId,
      provider,
      providerClientId: clientId,
      subject,
      encryptedRevocationGrant: crypto.encrypt(
        JSON.stringify({
          provider,
          clientId,
          subject,
          accessToken: 'isolated-access-token',
          refreshToken: null,
          accessTokenExpiresAt: Date.now() + 60_000,
          refreshTokenExpiresAt: null,
        }),
      ),
    });
  }

  async function tokens(owner: AccountEntity) {
    for (const type of [
      'refresh_token',
      'sso_session',
      'authorization_code',
      'portal_mfa',
    ] as const) {
      await database.getRepository(TokenRecordEntity).save({
        accountId: owner.id,
        clientId: 'existing-service-client',
        type,
        status: 'active',
        tokenHash: hashToken(randomBytes(32).toString('base64url')),
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
        metadataJson: { credentialVersion: owner.credentialVersion },
      });
    }
  }

  async function seedBusiness(actor: PortalActor, other: PortalActor) {
    const service = await database.getRepository(ServiceEntity).save({
      serviceKey: 'lifecycle-service',
      name: 'Retained service',
      description: '',
      status: 'active',
    });
    const permission = await database
      .getRepository(ServicePermissionDefinitionEntity)
      .save({
        serviceId: service.id,
        key: 'member',
        label: 'Member',
        description: '',
        status: 'active',
        sortOrder: 0,
      });
    for (const accountId of [actor.account.id, other.account.id]) {
      await database.getRepository(AccountServicePermissionEntity).save({
        accountId,
        serviceId: service.id,
        permissionDefinitionId: permission.id,
        status: 'active',
        grantedByAccountId: actor.account.id,
        grantedAt: new Date(),
      });
    }
    await database.getRepository(ServiceApplicationEntity).save({
      accountId: actor.account.id,
      serviceId: service.id,
      status: 'approved',
      message: 'Remove own application',
    });
    const otherApplication = await database
      .getRepository(ServiceApplicationEntity)
      .save({
        accountId: other.account.id,
        serviceId: service.id,
        status: 'approved',
        message: 'Retain other application',
        reviewedByAccountId: actor.account.id,
      });
    const audit = await database.getRepository(AuditLogEntity).save({
      actorAccountId: actor.account.id,
      action: 'service.approve',
      targetType: 'service',
      targetId: service.id,
      beforeJson: null,
      afterJson: {
        serviceKey: service.serviceKey,
        accountId: actor.account.id,
        email: actor.account.email,
      },
      ipAddress: '127.0.0.1',
      userAgent: 'isolated-test',
    });
    const onboarding = await database
      .getRepository(ServiceOnboardingRequestEntity)
      .save({
        serviceKey: service.serviceKey,
        kind: 'create',
        status: 'approved',
        revision: 1,
        requestSecretHash: 'one-way-request-secret',
        requesterName: actor.account.name,
        requesterEmail: actor.account.email,
        requestedSpecJson: {
          serviceKey: service.serviceKey,
          requesterName: actor.account.name,
          requesterEmail: actor.account.email,
        },
        approvedSnapshotJson: null,
        decidedByAccountId: actor.account.id,
      });
    await database.getRepository(AccountPolicyConsentEntity).save({
      accountId: actor.account.id,
      termsVersion: 'test-terms',
      privacyVersion: 'test-privacy',
      policyDigest: '1'.repeat(64),
      source: 'portal',
    });
    await database.query(
      `INSERT INTO permission_webhook_subscriptions
      (service_id, endpoint_url, secret_source, encrypted_secret, event_types, status)
      VALUES ($1, 'https://receiver.example.test/events', 'generated', $2, ARRAY['permission.updated'], 'active')`,
      [service.id, crypto.encrypt('isolated-webhook-secret')],
    );
    const device = randomUUID();
    const credential = randomUUID();
    const notification = randomUUID();
    await database.query(
      `INSERT INTO service_credentials (id, service_id, key_id, secret_hash, name, description, scopes, status)
      VALUES ($1, $2, $3, 'isolated-hash', 'Retained service credential', '', '{}', 'active')`,
      [credential, service.id, randomUUID()],
    );
    await database.query(
      `INSERT INTO notification_devices (id, account_id, installation_id, display_name, platform)
      VALUES ($1, $2, 'isolated-installation', 'Remove device', 'ios')`,
      [device, actor.account.id],
    );
    await database.query(
      `INSERT INTO notification_subscriptions (account_id, device_id, service_id, enabled)
      VALUES ($1, $2, $3, true)`,
      [actor.account.id, device, service.id],
    );
    await database.query(
      `INSERT INTO notifications (id, service_id, service_credential_id, account_id, title, body)
      VALUES ($1, $2, $3, $4, 'Remove notification', 'Remove own body')`,
      [notification, service.id, credential, actor.account.id],
    );
    return { service, otherApplication, audit, onboarding };
  }
});
