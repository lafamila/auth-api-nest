import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DataSource, MigrationExecutor, QueryRunner } from 'typeorm';
import { AppConfigService } from '../src/config/app-config.service';
import { AuthSchemaReadinessService } from '../src/database/auth-schema-readiness.service';
import { AddProviderRevocations20261118000000 } from '../src/database/migrations/20261118000000-AddProviderRevocations';
import { AddProviderEvents20261118000001 } from '../src/database/migrations/20261118000001-AddProviderEvents';
import { AddAccountPolicyConsents20261118000002 } from '../src/database/migrations/20261118000002-AddAccountPolicyConsents';
import { AddServiceCategories20261118000003 } from '../src/database/migrations/20261118000003-AddServiceCategories';

// Canonical: /Users/lafamila/work/teddy/.idea/AUTH_SOCIAL_PRODUCTION_READINESS_PLAN.md.
const BASELINE_CUTOFF = '20261116000000';
const CURRENT_CUTOFF = '20261118000003';
const READINESS_MIGRATIONS = [
  new AddProviderRevocations20261118000000(),
  new AddProviderEvents20261118000001(),
  new AddAccountPolicyConsents20261118000002(),
  new AddServiceCategories20261118000003(),
];
const READINESS_NAMES = READINESS_MIGRATIONS.map((migration) => migration.name);
const PRESERVED_TABLES = [
  'accounts',
  'services',
  'service_permission_definitions',
  'account_service_permissions',
  'admin_mfa',
  'admin_sessions',
  'oidc_clients',
  'social_identities',
  'signing_keys',
  'token_records',
] as const;
type Row = Record<string, unknown>;
const WHEN = new Date('2026-11-17T03:04:05.123Z');

function migrationPaths(cutoff: string): string[] {
  const directory = join(__dirname, '../src/database/migrations');
  return readdirSync(directory)
    .filter(
      (file) => /^\d{14}-.*\.ts$/.test(file) && file.slice(0, 14) <= cutoff,
    )
    .sort()
    .map((file) => join(directory, file));
}

function isolatedDatabase(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !/^auth_social_production_migrations_[a-z0-9_]+$/.test(database) ||
      [...url.searchParams.keys()].some((key) =>
        ['database', 'dbname', 'options', 'schema', 'search_path'].includes(
          key.toLowerCase(),
        ),
      )
    ) {
      return null;
    }
    return { url: value, database };
  } catch {
    return null;
  }
}

describe('Social production migration safety gate', () => {
  it.each([
    undefined,
    '',
    'not-a-database-url',
    'postgres://localhost/teddy_auth',
    'postgres://localhost/auth_portal_e2e',
    'postgres://localhost/other_auth_social_production_migrations_test',
    'mysql://localhost/auth_social_production_migrations_test',
    'postgres://localhost/auth_social_production_migrations_',
    'postgres://localhost/auth_social_production_migrations_test/other',
    'postgres://localhost/auth_social_production_migrations_test%2Fother',
    ...['database', 'dbname', 'options', 'schema', 'search_path', 'DBNAME'].map(
      (key) =>
        `postgres://localhost/auth_social_production_migrations_test?${key}=override`,
    ),
  ])('refuses unsafe database URLs without connecting: %s', (value) => {
    expect(isolatedDatabase(value)).toBeNull();
  });

  it.each(['postgres', 'postgresql'])(
    'accepts an explicit dedicated %s database',
    (protocol) => {
      const url = `${protocol}://localhost/auth_social_production_migrations_test`;
      expect(isolatedDatabase(url)).toEqual({
        url,
        database: 'auth_social_production_migrations_test',
      });
    },
  );

  it('pins the old baseline and exactly four readiness migrations', () => {
    const baseline = migrationPaths(BASELINE_CUTOFF).map((file) =>
      basename(file),
    );
    const current = migrationPaths(CURRENT_CUTOFF).map((file) =>
      basename(file),
    );
    expect(baseline.at(-1)).toBe(
      '20261116000000-AddAccountCredentialVersion.ts',
    );
    expect(current.slice(baseline.length)).toEqual([
      '20261118000000-AddProviderRevocations.ts',
      '20261118000001-AddProviderEvents.ts',
      '20261118000002-AddAccountPolicyConsents.ts',
      '20261118000003-AddServiceCategories.ts',
    ]);
  });

  it.each(READINESS_MIGRATIONS)(
    '$name refuses down outside a transaction before SQL',
    async (migration) => {
      const query = jest.fn();
      await expect(
        migration.down({
          isTransactionActive: false,
          query,
        } as unknown as QueryRunner),
      ).rejects.toThrow(/transaction/i);
      expect(query).not.toHaveBeenCalled();
    },
  );
});

// No fallback to DATABASE_URL/TEST_DATABASE_URL. The coordinator provisions an
// empty prefixed database and owns its eventual disposal; this file never resets it.
const database = isolatedDatabase(
  process.env.SOCIAL_PRODUCTION_MIGRATION_DATABASE_URL,
);
const describeDatabase = database ? describe : describe.skip;
jest.setTimeout(30_000);

describeDatabase(
  'Social production readiness real PostgreSQL migrations',
  () => {
    let legacy: DataSource;
    let upgraded: DataSource;
    let runner: QueryRunner;
    let baselineHistory: string[];
    let snapshots: Record<string, Row[]>;
    let adminId: string;
    let socialId: string;
    let serviceId: string;
    let identityId: string;

    function migrationSource(cutoff: string): DataSource {
      if (!database)
        throw new Error('An isolated migration database is required');
      return new DataSource({
        type: 'postgres',
        url: database.url,
        schema: 'public',
        entities: [],
        migrations: migrationPaths(cutoff),
        synchronize: false,
        migrationsRun: false,
        dropSchema: false,
        logging: false,
        connectTimeoutMS: 5000,
        applicationName: 'social-production-migrations-e2e',
      });
    }

    async function rows<T extends Row = Row>(
      source: DataSource | QueryRunner,
      sql: string,
      parameters: unknown[] = [],
    ): Promise<T[]> {
      const result: unknown = await source.query(sql, parameters);
      if (!Array.isArray(result)) throw new Error('Expected PostgreSQL rows');
      return result as T[];
    }

    async function history(
      source: DataSource | QueryRunner,
    ): Promise<string[]> {
      return (
        await rows<{ name: string }>(
          source,
          'SELECT name FROM migrations ORDER BY id',
        )
      ).map((row) => row.name);
    }

    function readiness(source: DataSource) {
      return new AuthSchemaReadinessService(source, {
        nodeEnv: 'test',
      } as AppConfigService).onModuleInit();
    }

    beforeAll(async () => {
      legacy = migrationSource(BASELINE_CUTOFF);
      await legacy.initialize();
      expect(
        await rows(
          legacy,
          'SELECT current_database() AS database, current_schema() AS schema',
        ),
      ).toEqual([{ database: database?.database, schema: 'public' }]);
      expect(
        await rows(
          legacy,
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
        ),
      ).toEqual([]);
      const applied = await legacy.runMigrations({ transaction: 'all' });
      baselineHistory = applied.map((migration) => migration.name);
      expect(baselineHistory.at(-1)).toBe(
        'AddAccountCredentialVersion20261116000000',
      );
      expect(
        baselineHistory.some((name) => READINESS_NAMES.includes(name)),
      ).toBe(false);

      const [admin] = await rows(
        legacy,
        `INSERT INTO accounts
        (login_id, name, email, password_hash, is_super_admin, credential_version, email_verified_at, last_login_at)
       VALUES ('readiness-admin', 'Existing admin', 'readiness-admin@example.test',
         'fixture-password-hash', true, 7, $1, $1) RETURNING *`,
        [WHEN],
      );
      adminId = String(admin.id);
      const [social] = await rows(
        legacy,
        `INSERT INTO accounts (name, email)
       VALUES ('Existing social account', 'readiness-social@example.test') RETURNING *`,
      );
      socialId = String(social.id);
      const [service] = await rows(
        legacy,
        `INSERT INTO services (service_key, name, description, permission_schema_version)
       VALUES ('game-platform', 'Existing game', 'Do not infer category from its name', 4) RETURNING *`,
      );
      serviceId = String(service.id);
      await legacy.query(
        `INSERT INTO services (service_key, name, status)
       VALUES ('legacy-travel', 'Existing travel', 'disabled')`,
      );
      const [permission] = await rows(
        legacy,
        `INSERT INTO service_permission_definitions (service_id, key, label, sort_order)
       VALUES ($1, 'player', 'Existing player', 3) RETURNING *`,
        [serviceId],
      );
      await legacy.query(
        `INSERT INTO account_service_permissions
        (account_id, service_id, permission_definition_id, status, granted_by_account_id, granted_at)
       VALUES ($1, $2, $3, 'active', $4, $5), ($4, $2, $3, 'suspended', $1, $5)`,
        [socialId, serviceId, permission.id, adminId, WHEN],
      );
      await legacy.query(
        `INSERT INTO admin_mfa (account_id, encrypted_otp_secret, algorithm, digits, period, verified_at)
       VALUES ($1, 'fixture-encrypted-otp-secret', 'SHA256', 8, 60, $2)`,
        [adminId, WHEN],
      );
      await legacy.query(
        `INSERT INTO admin_sessions
        (account_id, token_hash, idle_expires_at, absolute_expires_at, last_seen_at, credential_version)
       VALUES ($1, 'fixture-admin-token-hash', $2, $3, $4, 7)`,
        [
          adminId,
          new Date(WHEN.getTime() + 1_800_000),
          new Date(WHEN.getTime() + 43_200_000),
          WHEN,
        ],
      );
      await legacy.query(
        `INSERT INTO oidc_clients
        (service_id, client_id, client_secret_hash, client_type, redirect_uris, allowed_grant_types, allowed_scopes)
       VALUES ($1, 'readiness-client', 'fixture-secret-hash', 'confidential',
         ARRAY['https://rp.example.test/callback'], ARRAY['authorization_code', 'refresh_token'], ARRAY['openid'])`,
        [serviceId],
      );
      const [identity] = await rows(
        legacy,
        `INSERT INTO social_identities (account_id, provider, provider_client_id, subject)
       VALUES ($1, 'google', 'readiness-google-client', 'fixture-subject') RETURNING *`,
        [socialId],
      );
      identityId = String(identity.id);
      await legacy.query(
        `INSERT INTO signing_keys (kid, private_key_pem, public_key_jwk)
       VALUES ('fixture-kid', 'fixture-encrypted-signing-key', '{"kty":"RSA","kid":"fixture-kid"}')`,
      );
      await legacy.query(
        `INSERT INTO token_records (token_hash, type, status, family_id, account_id, client_id, service_id, metadata_json, expires_at)
       VALUES ('fixture-refresh-hash', 'refresh_token', 'active', 'fixture-family', $1, 'readiness-client', $2, '{"fixture":true}', $3)`,
        [socialId, serviceId, new Date(WHEN.getTime() + 3_600_000)],
      );
      snapshots = {};
      for (const table of PRESERVED_TABLES) {
        snapshots[table] = await rows(
          legacy,
          `SELECT * FROM ${table} ORDER BY id`,
        );
      }
      await expect(readiness(legacy)).rejects.toThrow(
        'Auth schema is not ready',
      );
      await legacy.destroy();

      upgraded = migrationSource(CURRENT_CUTOFF);
      await upgraded.initialize();
      expect(
        (await new MigrationExecutor(upgraded).getPendingMigrations()).map(
          (migration) => migration.name,
        ),
      ).toEqual(READINESS_NAMES);
      const all = [...upgraded.migrations];
      for (let index = 0; index < READINESS_NAMES.length; index++) {
        const visible = all.filter((migration) => {
          const position = READINESS_NAMES.indexOf(
            migration.name ?? migration.constructor.name,
          );
          return position < 0 || position <= index;
        });
        upgraded.migrations.splice(0, upgraded.migrations.length, ...visible);
        expect(
          (await upgraded.runMigrations({ transaction: 'all' })).map(
            (migration) => migration.name,
          ),
        ).toEqual([READINESS_NAMES[index]]);
        if (index < READINESS_NAMES.length - 1) {
          await expect(readiness(upgraded)).rejects.toThrow(
            'Auth schema is not ready',
          );
        } else {
          await expect(readiness(upgraded)).resolves.toBeUndefined();
        }
      }
      upgraded.migrations.splice(0, upgraded.migrations.length, ...all);
      expect(await upgraded.showMigrations()).toBe(false);
    }, 90_000);

    afterAll(async () => {
      if (upgraded?.isInitialized) await upgraded.destroy();
      if (legacy?.isInitialized) await legacy.destroy();
    });

    beforeEach(async () => {
      runner = upgraded.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
    });

    afterEach(async () => {
      if (runner?.isTransactionActive) await runner.rollbackTransaction();
      if (runner && !runner.isReleased) await runner.release();
    });

    async function expectSqlError(
      sql: string,
      parameters: unknown[],
      code: string,
      constraint?: string,
    ) {
      await runner.query('SAVEPOINT expected_error');
      try {
        await expect(runner.query(sql, parameters)).rejects.toMatchObject({
          driverError: expect.objectContaining({
            code,
            ...(constraint ? { constraint } : {}),
          }),
        });
      } finally {
        await runner.query('ROLLBACK TO SAVEPOINT expected_error');
        await runner.query('RELEASE SAVEPOINT expected_error');
      }
    }

    async function undoLaterMigrations(target: string) {
      const executor = new MigrationExecutor(upgraded, runner);
      const index = READINESS_NAMES.indexOf(target);
      if (index < 0) throw new Error('Unknown readiness migration');
      for (const name of READINESS_NAMES.slice(index + 1).reverse()) {
        expect((await history(runner)).at(-1)).toBe(name);
        await executor.undoLastMigration();
      }
      expect((await history(runner)).at(-1)).toBe(target);
      return executor;
    }

    async function expectGuardedDown(
      executor: MigrationExecutor,
      message: RegExp,
    ) {
      const before = await history(runner);
      await runner.query('SAVEPOINT guarded_down');
      try {
        await expect(executor.undoLastMigration()).rejects.toThrow(message);
      } finally {
        await runner.query('ROLLBACK TO SAVEPOINT guarded_down');
        await runner.query('RELEASE SAVEPOINT guarded_down');
      }
      expect(await history(runner)).toEqual(before);
    }

    it('preserves full account, permission, service, MFA, session, identity and signing/token records', async () => {
      for (const table of PRESERVED_TABLES) {
        const expected = snapshots[table].map((row) =>
          table === 'services'
            ? { ...row, category: 'other' }
            : table === 'social_identities'
              ? { ...row, encrypted_revocation_grant: null }
              : row,
        );
        expect(
          await rows(runner, `SELECT * FROM ${table} ORDER BY id`),
        ).toEqual(expected);
      }
      expect(await history(runner)).toEqual([
        ...baselineHistory,
        ...READINESS_NAMES,
      ]);
      expect(upgraded.options.synchronize).toBe(false);
    });

    it('does not fabricate historical consents, provider jobs/events or revocation grants', async () => {
      for (const table of [
        'account_policy_consents',
        'provider_revocation_jobs',
        'provider_events',
      ]) {
        expect(
          await rows(runner, `SELECT count(*)::int AS count FROM ${table}`),
        ).toEqual([{ count: 0 }]);
      }
      expect(
        await rows(
          runner,
          'SELECT encrypted_revocation_grant FROM social_identities WHERE id=$1',
          [identityId],
        ),
      ).toEqual([{ encrypted_revocation_grant: null }]);
      const identities = await runner.getTable('public.social_identities');
      expect(
        identities?.findColumnByName('encrypted_revocation_grant'),
      ).toMatchObject({ type: 'text', isNullable: true });
    });

    it('defaults old and new services to other and enforces the fixed category enum', async () => {
      expect(
        await rows(runner, 'SELECT DISTINCT category FROM services'),
      ).toEqual([{ category: 'other' }]);
      expect(
        await rows(
          runner,
          "INSERT INTO services (service_key,name) VALUES ('new-service','New') RETURNING category",
        ),
      ).toEqual([{ category: 'other' }]);
      for (const category of [
        'game',
        'productivity',
        'education',
        'community',
        'communication',
        'content',
        'travel',
        'health',
        'finance',
        'commerce',
        'developer_tools',
        'other',
      ]) {
        await runner.query('UPDATE services SET category=$1 WHERE id=$2', [
          category,
          serviceId,
        ]);
      }
      await expectSqlError(
        'UPDATE services SET category=$1 WHERE id=$2',
        ['unknown', serviceId],
        '23514',
        'chk_services_category',
      );
      await expectSqlError(
        'UPDATE services SET category=NULL WHERE id=$1',
        [serviceId],
        '23502',
      );
    });

    const insertJob = `INSERT INTO provider_revocation_jobs
    (reason,status,target_hash,encrypted_payload,attempts,created_at,deadline_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`;
    function jobParameters(): unknown[] {
      return [
        'unlink',
        'pending',
        'a'.repeat(64),
        'fixture-encrypted-payload',
        0,
        WHEN,
        new Date(WHEN.getTime() + 86_400_000),
      ];
    }

    it('creates retry defaults, a maximum 24-hour deadline and indexed timezone-aware scheduling', async () => {
      const [job] = await rows(
        runner,
        `INSERT INTO provider_revocation_jobs (reason,target_hash,encrypted_payload)
      VALUES ('withdraw',$1,'fixture-encrypted-payload') RETURNING *, deadline_at-created_at AS retention`,
        ['b'.repeat(64)],
      );
      expect(job).toMatchObject({
        status: 'pending',
        attempts: 0,
        lease_token: null,
        lease_expires_at: null,
        last_error_code: null,
        completed_at: null,
      });
      expect(
        await rows(
          runner,
          "SELECT deadline_at=created_at+interval '24 hours' AS bounded FROM provider_revocation_jobs WHERE id=$1",
          [job.id],
        ),
      ).toEqual([{ bounded: true }]);
      const table = await runner.getTable('public.provider_revocation_jobs');
      expect(table?.findColumnByName('deadline_at')).toMatchObject({
        type: 'timestamp with time zone',
        isNullable: false,
      });
      expect(table?.indices.map((index) => index.name)).toEqual(
        expect.arrayContaining([
          'idx_provider_revocations_due',
          'idx_provider_revocations_target',
        ]),
      );
      await runner.query(
        "UPDATE provider_revocation_jobs SET encrypted_payload=NULL,status='succeeded' WHERE id=$1",
        [job.id],
      );
    });

    it.each([
      ['reason', 0, 'invalid'],
      ['status', 1, 'invalid'],
      ['short target hash', 2, 'abc'],
      ['non-hex target hash', 2, 'g'.repeat(64)],
      ['negative attempts', 4, -1],
      ['too many attempts', 4, 9],
      ['terminal success payload', 1, 'succeeded'],
      ['terminal manual payload', 1, 'manual_required'],
      ['overlong retention', 6, new Date(WHEN.getTime() + 86_400_001)],
    ] as const)(
      'rejects invalid provider revocation %s',
      async (_label, index, value) => {
        const parameters = jobParameters();
        parameters[index] = value;
        await expectSqlError(insertJob, parameters, '23514');
      },
    );

    const insertEvent = `INSERT INTO provider_events
    (id,provider,dedup_hash,encrypted_target,expires_at,processed_at,lease_token,lease_until,attempts)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`;
    function eventParameters(): unknown[] {
      return [
        randomUUID(),
        'kakao',
        'c'.repeat(64),
        'fixture-encrypted-target',
        new Date(WHEN.getTime() + 3_600_000),
        null,
        null,
        null,
        0,
      ];
    }

    it('deduplicates provider receipts, preserves expiry and allows only processed ciphertext removal', async () => {
      const parameters = eventParameters();
      const [event] = await rows(runner, insertEvent, parameters);
      expect(event).toMatchObject({
        expires_at: parameters[4],
        attempts: 0,
        lease_token: null,
        lease_until: null,
        processed_at: null,
      });
      const duplicate = [...parameters];
      duplicate[0] = randomUUID();
      await expectSqlError(
        insertEvent,
        duplicate,
        '23505',
        'uq_provider_event_dedup',
      );
      duplicate[1] = 'google';
      await runner.query(insertEvent, duplicate);
      await runner.query(
        'UPDATE provider_events SET processed_at=$1,encrypted_target=NULL WHERE id=$2',
        [WHEN, event.id],
      );
      const table = await runner.getTable('public.provider_events');
      expect(table?.findColumnByName('expires_at')).toMatchObject({
        type: 'timestamp with time zone',
        isNullable: false,
      });
      expect(table?.indices.map((index) => index.name)).toEqual(
        expect.arrayContaining([
          'idx_provider_event_due',
          'idx_provider_event_expiry',
        ]),
      );
    });

    it.each([
      ['provider', 1, 'unknown', 'chk_provider_event_provider'],
      ['attempts', 8, -1, 'chk_provider_event_attempts'],
      [
        'lease token only',
        6,
        '00000000-0000-4000-8000-000000000001',
        'chk_provider_event_lease',
      ],
      ['lease expiry only', 7, WHEN, 'chk_provider_event_lease'],
      ['pending without ciphertext', 3, null, 'chk_provider_event_payload'],
      ['processed with ciphertext', 5, WHEN, 'chk_provider_event_payload'],
    ] as const)(
      'rejects invalid provider event %s',
      async (_label, index, value, constraint) => {
        const parameters = eventParameters();
        parameters[index] = value;
        await expectSqlError(insertEvent, parameters, '23514', constraint);
      },
    );

    const insertConsent = `INSERT INTO account_policy_consents
    (account_id,terms_version,privacy_version,policy_digest,source)
    VALUES ($1,'terms-v1','privacy-v1',$2,$3) RETURNING *`;

    it('records only explicit valid consents with ownership and revision uniqueness', async () => {
      const parameters = [socialId, 'd'.repeat(64), 'social_signup'];
      const [consent] = await rows(runner, insertConsent, parameters);
      expect(consent).toMatchObject({
        account_id: socialId,
        source: 'social_signup',
      });
      expect(consent.accepted_at).toBeInstanceOf(Date);
      await expectSqlError(
        insertConsent,
        parameters,
        '23505',
        'uq_account_policy_consents',
      );
      await expectSqlError(
        insertConsent,
        [randomUUID(), 'e'.repeat(64), 'signup'],
        '23503',
      );
      await expectSqlError(
        insertConsent,
        [adminId, 'f'.repeat(64), 'fabricated'],
        '23514',
      );
      await expectSqlError(
        insertConsent,
        [null, 'f'.repeat(64), 'portal'],
        '23502',
      );
      await runner.query(insertConsent, [socialId, 'e'.repeat(64), 'portal']);
      const table = await runner.getTable('public.account_policy_consents');
      expect(table?.foreignKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            columnNames: ['account_id'],
            onDelete: 'CASCADE',
          }),
        ]),
      );
    });

    it('cascades consent ownership only when its account is deleted', async () => {
      const [account] = await rows(
        runner,
        "INSERT INTO accounts(name,email) VALUES ('Consent owner',$1) RETURNING id",
        [`${randomUUID()}@example.test`],
      );
      const [consent] = await rows(runner, insertConsent, [
        account.id,
        'd'.repeat(64),
        'signup',
      ]);
      await runner.query('DELETE FROM accounts WHERE id=$1', [account.id]);
      expect(
        await rows(
          runner,
          'SELECT id FROM account_policy_consents WHERE id=$1',
          [consent.id],
        ),
      ).toEqual([]);
      expect(
        await rows(runner, 'SELECT id FROM accounts WHERE id=$1', [adminId]),
      ).toEqual([{ id: adminId }]);
    });

    it('guards down against configured service categories and retains data/history', async () => {
      await runner.query("UPDATE services SET category='game' WHERE id=$1", [
        serviceId,
      ]);
      await expectGuardedDown(
        new MigrationExecutor(upgraded, runner),
        /configured service login-policy categories/i,
      );
      expect(
        await rows(runner, 'SELECT category FROM services WHERE id=$1', [
          serviceId,
        ]),
      ).toEqual([{ category: 'game' }]);
    });

    it('guards down against recorded consents and retains data/history', async () => {
      const executor = await undoLaterMigrations(READINESS_NAMES[2]);
      const [consent] = await rows(runner, insertConsent, [
        socialId,
        'd'.repeat(64),
        'portal',
      ]);
      await expectGuardedDown(executor, /recorded account policy consents/i);
      expect(
        await rows(
          runner,
          'SELECT * FROM account_policy_consents WHERE id=$1',
          [consent.id],
        ),
      ).toEqual([consent]);
    });

    it('guards down against unprocessed provider events and retains data/history', async () => {
      const executor = await undoLaterMigrations(READINESS_NAMES[1]);
      const [event] = await rows(runner, insertEvent, eventParameters());
      await expectGuardedDown(executor, /unprocessed provider events/i);
      expect(
        await rows(runner, 'SELECT * FROM provider_events WHERE id=$1', [
          event.id,
        ]),
      ).toEqual([event]);
    });

    it('guards down against pending encrypted revocations and retains data/history', async () => {
      const executor = await undoLaterMigrations(READINESS_NAMES[0]);
      const [job] = await rows(runner, insertJob, jobParameters());
      await expectGuardedDown(executor, /pending provider revocations/i);
      expect(
        await rows(
          runner,
          'SELECT * FROM provider_revocation_jobs WHERE id=$1',
          [job.id],
        ),
      ).toEqual([job]);
    });

    it('must not discard a retained identity revocation grant during down', async () => {
      const executor = await undoLaterMigrations(READINESS_NAMES[0]);
      await runner.query(
        'UPDATE social_identities SET encrypted_revocation_grant=$1 WHERE id=$2',
        ['fixture-retained-grant', identityId],
      );
      // Regression for a source defect: down currently guards job payloads only.
      await expectGuardedDown(executor, /revocation|grant/i);
      expect(
        await rows(
          runner,
          'SELECT encrypted_revocation_grant FROM social_identities WHERE id=$1',
          [identityId],
        ),
      ).toEqual([{ encrypted_revocation_grant: 'fixture-retained-grant' }]);
    });

    it('can revert an unused readiness schema without altering historical data', async () => {
      const executor = new MigrationExecutor(upgraded, runner);
      for (const name of [...READINESS_NAMES].reverse()) {
        expect((await history(runner)).at(-1)).toBe(name);
        await executor.undoLastMigration();
      }
      expect(await history(runner)).toEqual(baselineHistory);
      for (const table of PRESERVED_TABLES) {
        expect(
          await rows(runner, `SELECT * FROM ${table} ORDER BY id`),
        ).toEqual(snapshots[table]);
      }
      for (const table of [
        'provider_revocation_jobs',
        'provider_events',
        'account_policy_consents',
      ]) {
        expect(
          await rows(runner, 'SELECT to_regclass($1) AS name', [
            `public.${table}`,
          ]),
        ).toEqual([{ name: null }]);
      }
      expect(
        (await executor.getPendingMigrations()).map(
          (migration) => migration.name,
        ),
      ).toEqual(READINESS_NAMES);
    });
  },
);
