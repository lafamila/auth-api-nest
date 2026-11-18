import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AesGcmService } from '../src/common/crypto/aes-gcm.service';
import { hashToken } from '../src/common/crypto/token-hash';
import { AppConfigService } from '../src/config/app-config.service';
import { AUTH_ENTITIES } from '../src/database/database.module';
import { AccountEntity } from '../src/database/entities/account.entity';
import { AdminBootstrapChallengeEntity } from '../src/database/entities/admin-bootstrap-challenge.entity';
import { AuditLogEntity } from '../src/database/entities/audit-log.entity';
import { EmailVerificationEntity } from '../src/database/entities/email-verification.entity';
import { ProviderRevocationJobEntity } from '../src/database/entities/provider-revocation-job.entity';
import { ServiceEntity } from '../src/database/entities/service.entity';
import { SocialIdentityEntity } from '../src/database/entities/social-identity.entity';
import { SocialLoginTransactionEntity } from '../src/database/entities/social-login-transaction.entity';
import { TokenRecordEntity } from '../src/database/entities/token-record.entity';
import { PrivacyRetentionService } from '../src/policies/privacy-retention.service';
import { ProviderRevocationsClient } from '../src/social/provider-revocations.client';
import { ProviderRevocationsService } from '../src/social/provider-revocations.service';
import type { SocialIdentityProfile } from '../src/social/social-provider.types';

const isolated = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const CLIENT_ID = 'retention-isolated-google-client';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Validate before opening any connection; never fall back to DATABASE_URL or
// accept URL options that can redirect SQL outside the disposable schema/DB.
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
      'Retention integration tests require auth_portal_e2e without database or search-path overrides',
    );
  return value;
}

jest.setTimeout(30_000);

isolated('Privacy retention (disposable schema in auth_portal_e2e)', () => {
  const schema = `auth_retention_${randomUUID().replaceAll('-', '')}`;
  let database: DataSource;
  let provisioning: DataSource;
  let service: PrivacyRetentionService;
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
      entities: AUTH_ENTITIES,
      migrations: [join(__dirname, '../src/database/migrations/*.ts')],
      synchronize: false,
    });
    await database.initialize();
    await database.runMigrations();
    const settings = new ConfigService({
      NODE_ENV: 'test',
      ADMIN_OTP_ENCRYPTION_KEY: 'retention-isolated-test-key',
      SOCIAL_GOOGLE_CLIENT_ID: CLIENT_ID,
      SOCIAL_REVOCATIONS_ENABLED: 'false',
      AUTH_PRIVACY_AUTH_DATA_RETENTION_HOURS: '1',
      AUTH_PRIVACY_AUDIT_RETENTION_DAYS: '30',
      AUTH_PUBLIC_BACKUP_RETENTION_DAYS: '7',
    });
    crypto = new AesGcmService(new AppConfigService(settings));
    service = new PrivacyRetentionService(
      database,
      settings,
      new ProviderRevocationsService(
        database,
        settings,
        crypto,
        new ProviderRevocationsClient(settings),
      ),
    );
  });

  beforeEach(async () => {
    const tables = database.entityMetadatas.map(
      (metadata) => `"${schema}".${database.driver.escape(metadata.tableName)}`,
    );
    await database.query(`TRUNCATE ${tables.join(', ')} CASCADE`);
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('Retention must never call provider HTTP'));
  });

  afterEach(() => {
    try {
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
  });

  afterAll(async () => {
    if (database?.isInitialized) await database.destroy();
    if (provisioning?.isInitialized) {
      try {
        if (schemaCreated)
          await provisioning.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await provisioning.destroy();
      }
    }
  });

  it('deletes retention-eligible auth data and old audits while preserving fresh rows, accounts and services', async () => {
    const now = Date.now();
    const old = new Date(now - 2 * HOUR);
    const recent = new Date(now - 10 * 60_000);
    const expired = new Date(now - 60_000);
    const future = new Date(now + HOUR);
    const windows = [
      { createdAt: old, expiresAt: expired },
      { createdAt: recent, expiresAt: future },
      { createdAt: recent, expiresAt: expired },
      { createdAt: old, expiresAt: future },
    ];
    const account = await database.getRepository(AccountEntity).save({
      name: 'Retained account',
      email: `${randomUUID()}@example.test`,
      loginId: null,
      passwordHash: null,
      createdAt: new Date(now - 60 * DAY),
    });
    const application = await database.getRepository(ServiceEntity).save({
      serviceKey: 'retention-preserved-service',
      name: 'Retained service',
      createdAt: new Date(now - 60 * DAY),
    });
    const accountsBefore = await database.getRepository(AccountEntity).find();
    const servicesBefore = await database.getRepository(ServiceEntity).find();
    const emails = await database.getRepository(EmailVerificationEntity).save(
      windows.map((window) => ({
        ...window,
        email: `${randomUUID()}@example.test`,
        codeHash: hashToken(randomUUID()),
      })),
    );
    const challenges = await database
      .getRepository(AdminBootstrapChallengeEntity)
      .save(
        windows.map((window) => ({
          ...window,
          loginId: `retention-${randomUUID()}`,
          name: 'Disposable bootstrap',
          email: `${randomUUID()}@example.test`,
          passwordHash: 'disposable-unused-password-hash',
          encryptedOtpSecret: crypto.encrypt('disposable-otp-secret'),
        })),
      );
    await socialTransaction(old, expired);
    await socialTransaction(recent, expired);
    await socialTransaction(old, future);
    const freshSocial = await socialTransaction(recent, future);
    const tokens = await database.getRepository(TokenRecordEntity).save(
      windows.slice(0, 2).map((window) => ({
        ...window,
        tokenHash: hashToken(randomUUID()),
        type: 'portal_session' as const,
        status: 'active' as const,
        accountId: account.id,
        clientId: CLIENT_ID,
        serviceId: application.id,
      })),
    );
    const audits = await database.getRepository(AuditLogEntity).save(
      [31, 29, 0].map((days) => ({
        actorAccountId: account.id,
        action: 'retention.test',
        targetType: 'service',
        targetId: application.id,
        afterJson: { retained: true },
        createdAt: new Date(now - days * DAY),
      })),
    );

    await service.processOnce();

    // Recently expired verification rows still protect the one-hour rate window;
    // old but unexpired challenges are not deleted by the expiry predicates.
    const remainingEmails = await database
      .getRepository(EmailVerificationEntity)
      .find();
    expect(remainingEmails.map((row) => row.id).sort()).toEqual(
      emails
        .slice(1)
        .map((row) => row.id)
        .sort(),
    );
    const remainingChallenges = await database
      .getRepository(AdminBootstrapChallengeEntity)
      .find();
    expect(remainingChallenges.map((row) => row.id).sort()).toEqual(
      challenges
        .slice(1)
        .map((row) => row.id)
        .sort(),
    );
    const remainingSocial = await database
      .getRepository(SocialLoginTransactionEntity)
      .find();
    expect(remainingSocial).toEqual([freshSocial]);
    const remainingTokens = await database
      .getRepository(TokenRecordEntity)
      .find();
    expect(remainingTokens.map((row) => row.id)).toEqual([tokens[1].id]);
    const remainingAudits = await database.getRepository(AuditLogEntity).find();
    expect(remainingAudits.map((row) => row.id).sort()).toEqual(
      audits
        .slice(1)
        .map((row) => row.id)
        .sort(),
    );
    expect(await database.getRepository(AccountEntity).find()).toEqual(
      accountsBefore,
    );
    expect(await database.getRepository(ServiceEntity).find()).toEqual(
      servicesBefore,
    );
    expect(
      await database.getRepository(ProviderRevocationJobEntity).count(),
    ).toBe(0);
  });

  it('persists an encrypted abandoned-grant revocation before deletion but never revokes a registered identity', async () => {
    const abandoned = socialProfile();
    const registered = socialProfile();
    const owner = await database.getRepository(AccountEntity).save({
      name: 'Registered social account',
      email: `${randomUUID()}@example.test`,
      loginId: null,
      passwordHash: null,
    });
    await database.getRepository(SocialIdentityEntity).save({
      accountId: owner.id,
      provider: registered.provider,
      providerClientId: registered.providerClientId,
      subject: registered.subject,
      encryptedRevocationGrant: registered.encryptedRevocationGrant,
    });
    const identitiesBefore = await database
      .getRepository(SocialIdentityEntity)
      .find();
    const expired = new Date(Date.now() - 60_000);
    const created = new Date(Date.now() - 2 * HOUR);
    const transaction = await socialTransaction(created, expired, abandoned);
    await socialTransaction(created, expired, registered);

    // A real DB trigger rejects delete-first implementations, even if they
    // would eventually insert the right outbox row in the same transaction.
    await database.query(`
      CREATE FUNCTION "${schema}".require_queued_revocation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${transaction.id}'::uuid AND NOT EXISTS (
          SELECT 1 FROM "${schema}".provider_revocation_jobs
          WHERE reason = 'unlink' AND status = 'pending'
        ) THEN
          RAISE EXCEPTION 'Abandoned grant must be queued before deletion';
        END IF;
        RETURN OLD;
      END; $$
    `);
    await database.query(`
      CREATE TRIGGER retention_queue_before_delete
      BEFORE DELETE ON "${schema}".social_login_transactions
      FOR EACH ROW EXECUTE FUNCTION "${schema}".require_queued_revocation()
    `);
    try {
      await service.processOnce();
    } finally {
      await database.query(
        `DROP TRIGGER retention_queue_before_delete ON "${schema}".social_login_transactions`,
      );
      await database.query(
        `DROP FUNCTION "${schema}".require_queued_revocation()`,
      );
    }

    expect(
      await database.getRepository(SocialLoginTransactionEntity).count(),
    ).toBe(0);
    expect(await database.getRepository(SocialIdentityEntity).find()).toEqual(
      identitiesBefore,
    );
    expect(
      await database.getRepository(AccountEntity).countBy({ id: owner.id }),
    ).toBe(1);
    const jobs = await database
      .getRepository(ProviderRevocationJobEntity)
      .createQueryBuilder('job')
      .addSelect('job.encryptedPayload')
      .getMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      reason: 'unlink',
      status: 'pending',
      attempts: 0,
    });
    expect(jobs[0].encryptedPayload).not.toContain(abandoned.subject);
    expect(jobs[0].encryptedPayload).not.toContain(
      'retention-disposable-access-token',
    );
    expect(JSON.parse(crypto.decrypt(jobs[0].encryptedPayload!))).toEqual(
      JSON.parse(crypto.decrypt(abandoned.encryptedRevocationGrant!)),
    );
    expect(jobs[0].deadlineAt.getTime() - jobs[0].createdAt.getTime()).toBe(
      DAY,
    );
    await service.processOnce();
    expect(
      await database.getRepository(ProviderRevocationJobEntity).count(),
    ).toBe(1);
  });

  it('rolls back usable-grant removal when queue persistence fails at commit and permits a safe retry', async () => {
    const profile = socialProfile();
    const transaction = await socialTransaction(
      new Date(Date.now() - 2 * HOUR),
      new Date(Date.now() - 60_000),
      profile,
    );
    // Deferred failure happens after cleanup has removed the source row, so a
    // missing surrounding transaction would lose the only usable grant.
    await database.query(`
      CREATE FUNCTION "${schema}".reject_revocation_commit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'retention test queue persistence failure';
      END; $$
    `);
    await database.query(`
      CREATE CONSTRAINT TRIGGER retention_queue_commit_failure
      AFTER INSERT ON "${schema}".provider_revocation_jobs
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_revocation_commit()
    `);
    try {
      await expect(service.processOnce()).rejects.toThrow(
        'retention test queue persistence failure',
      );
      expect(
        await database.getRepository(SocialLoginTransactionEntity).findOneBy({
          id: transaction.id,
        }),
      ).toEqual(transaction);
      expect(
        await database.getRepository(ProviderRevocationJobEntity).count(),
      ).toBe(0);
    } finally {
      await database.query(
        `DROP TRIGGER retention_queue_commit_failure ON "${schema}".provider_revocation_jobs`,
      );
      await database.query(
        `DROP FUNCTION "${schema}".reject_revocation_commit()`,
      );
    }

    await service.processOnce();
    expect(
      await database.getRepository(SocialLoginTransactionEntity).count(),
    ).toBe(0);
    expect(
      await database.getRepository(ProviderRevocationJobEntity).count(),
    ).toBe(1);
  });

  function socialProfile(): SocialIdentityProfile {
    const subject = randomUUID();
    return {
      provider: 'google',
      providerClientId: CLIENT_ID,
      subject,
      email: null,
      emailVerified: false,
      name: 'Disposable social signup',
      encryptedRevocationGrant: crypto.encrypt(
        JSON.stringify({
          provider: 'google',
          clientId: CLIENT_ID,
          subject,
          accessToken: 'retention-disposable-access-token',
          refreshToken: null,
          accessTokenExpiresAt: Date.now() + HOUR,
          refreshTokenExpiresAt: null,
        }),
      ),
    };
  }

  async function socialTransaction(
    createdAt: Date,
    expiresAt: Date,
    profile?: SocialIdentityProfile,
  ) {
    return database.getRepository(SocialLoginTransactionEntity).save({
      tokenHash: hashToken(randomUUID()),
      browserBindingHash: hashToken(randomUUID()),
      provider: 'google',
      phase: profile ? 'signup' : 'authorization',
      data: {
        request: null,
        sessionAccountId: null,
        providerClientId: CLIENT_ID,
        ...(profile ? { profile } : {}),
      },
      createdAt,
      expiresAt,
    });
  }
});
