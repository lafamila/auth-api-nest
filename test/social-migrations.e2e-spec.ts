import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DataSource, MigrationExecutor, QueryRunner, Table } from 'typeorm';
import { AddSocialLogin20261104000001 } from '../src/database/migrations/20261104000001-AddSocialLogin';

const SOCIAL_MIGRATIONS = [
  'AllowSocialOnlyAccounts20261104000000',
  'AddSocialLogin20261104000001',
];

function isolatedDatabase(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !database.startsWith('auth_social_migrations_') ||
      database.includes('/') ||
      [...url.searchParams.keys()].some((key) =>
        ['database', 'dbname'].includes(key.toLowerCase()),
      )
    ) {
      return null;
    }
    return { url: value, database };
  } catch {
    return null;
  }
}

describe('Social migration database safety gate', () => {
  it.each([
    undefined,
    '',
    'not-a-database-url',
    'postgres://localhost/teddy_auth',
    'postgres://localhost/other_auth_social_migrations_test',
    'mysql://localhost/auth_social_migrations_test',
    'postgres://localhost/auth_social_migrations_test/other',
    'postgres://localhost/auth_social_migrations_test%2Fother',
    'postgres://localhost/auth_social_migrations_test?database=teddy_auth',
    'postgres://localhost/auth_social_migrations_test?dbname=teddy_auth',
  ])('does not enable database tests for %s', (value) => {
    expect(isolatedDatabase(value)).toBeNull();
  });

  it.each(['postgres', 'postgresql'])(
    'accepts an explicitly isolated %s database',
    (protocol) => {
      const url = `${protocol}://localhost/auth_social_migrations_test`;
      expect(isolatedDatabase(url)).toEqual({
        url,
        database: 'auth_social_migrations_test',
      });
    },
  );
});

describe('Social migration rollback safety', () => {
  it('refuses rollback outside an active transaction before executing SQL', async () => {
    const query = jest.fn();
    const runner = {
      isTransactionActive: false,
      query,
    } as unknown as QueryRunner;

    await expect(
      new AddSocialLogin20261104000001().down(runner),
    ).rejects.toThrow(/active transaction/i);
    expect(query).not.toHaveBeenCalled();
  });
});

// Never fall back to DATABASE_URL or the application e2e database.
const database = isolatedDatabase(process.env.SOCIAL_MIGRATION_DATABASE_URL);
const describeDatabase = database ? describe : describe.skip;

describeDatabase('Social login real migrations (e2e)', () => {
  let legacy: DataSource;
  let upgraded: DataSource;
  let runner: QueryRunner;
  let legacyAccount: Record<string, unknown>;
  let legacyEmail: Record<string, unknown>;
  let legacyMigrationNames: string[];

  function migrationSource(): DataSource {
    if (!database)
      throw new Error('An isolated migration database is required');
    return new DataSource({
      type: 'postgres',
      url: database.url,
      schema: 'public',
      entities: [],
      migrations: [join(__dirname, '../src/database/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
      dropSchema: false,
      logging: false,
      connectTimeoutMS: 5000,
      applicationName: 'social-migrations-e2e',
    });
  }

  beforeAll(async () => {
    legacy = migrationSource();
    await legacy.initialize();
    const connection = await legacy.query<
      Array<{ database: string; schema: string }>
    >('SELECT current_database() AS database, current_schema() AS schema');
    expect(connection).toEqual([
      { database: database?.database, schema: 'public' },
    ]);
    const existingTables = await legacy.query<Array<{ tablename: string }>>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    expect(existingTables).toEqual([]);

    const withheld = legacy.migrations.filter((migration) =>
      SOCIAL_MIGRATIONS.includes(migration.name ?? migration.constructor.name),
    );
    expect(withheld.map((migration) => migration.name).sort()).toEqual(
      [...SOCIAL_MIGRATIONS].sort(),
    );
    const oldMigrations = legacy.migrations.filter(
      (migration) => !withheld.includes(migration),
    );
    legacy.migrations.splice(0, legacy.migrations.length, ...oldMigrations);
    const applied = await legacy.runMigrations({ transaction: 'all' });
    legacyMigrationNames = applied.map((migration) => migration.name);
    expect(applied).toHaveLength(oldMigrations.length);
    expect(applied.length).toBeGreaterThan(0);
    expect(
      legacyMigrationNames.filter((name) => SOCIAL_MIGRATIONS.includes(name)),
    ).toEqual([]);

    [legacyAccount] = await legacy.query<Array<Record<string, unknown>>>(
      `INSERT INTO accounts
        (login_id, name, email, password_hash, email_verified_at, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        'migration-local-user',
        'Existing local user',
        'migration-local@example.test',
        'existing-local-password-hash',
        new Date('2026-10-01T01:02:03.000Z'),
        new Date('2026-10-02T04:05:06.000Z'),
      ],
    );
    [legacyEmail] = await legacy.query<Array<Record<string, unknown>>>(
      `INSERT INTO email_verifications (email, code_hash, expires_at)
       VALUES ($1, $2, $3) RETURNING *`,
      [
        'legacy-verification@example.test',
        'existing-verification-code-hash',
        new Date('2026-10-03T07:08:09.000Z'),
      ],
    );
    await legacy.destroy();

    upgraded = migrationSource();
    await upgraded.initialize();
    const pending = await new MigrationExecutor(
      upgraded,
    ).getPendingMigrations();
    expect(pending.map((migration) => migration.name)).toEqual(
      SOCIAL_MIGRATIONS,
    );
    const newMigrations = await upgraded.runMigrations({ transaction: 'all' });
    expect(newMigrations.map((migration) => migration.name)).toEqual(
      SOCIAL_MIGRATIONS,
    );
    expect(await upgraded.showMigrations()).toBe(false);
  }, 60000);

  afterAll(async () => {
    // The coordinator owns this database's disposal; never drop or reset it.
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

  async function table(name: string): Promise<Table> {
    const result = await runner.getTable(`public.${name}`);
    if (!result) throw new Error(`Missing migrated table: ${name}`);
    return result;
  }

  async function queryRows<Row extends Record<string, unknown>>(
    sql: string,
    parameters: unknown[] = [],
  ): Promise<Row[]> {
    const result: unknown = await runner.query(sql, parameters);
    if (!Array.isArray(result)) {
      throw new Error('Expected an array of PostgreSQL rows');
    }
    return result as Row[];
  }

  async function account(
    loginId: string | null = null,
    passwordHash: string | null = null,
  ) {
    const id = randomUUID();
    await runner.query(
      `INSERT INTO accounts (id, login_id, name, email, password_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, loginId, 'Migration account', `${id}@example.test`, passwordHash],
    );
    return id;
  }

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

  async function migrationHistory(): Promise<string[]> {
    const rows = await queryRows<{ name: string }>(
      'SELECT name FROM migrations ORDER BY id',
    );
    return rows.map((row) => row.name);
  }

  it('preserves the full existing local account and records the actual migration chain', async () => {
    expect(
      await runner.query('SELECT * FROM accounts WHERE id = $1', [
        legacyAccount.id,
      ]),
    ).toEqual([legacyAccount]);
    expect(await migrationHistory()).toEqual([
      ...legacyMigrationNames,
      ...SOCIAL_MIGRATIONS,
    ]);
    expect(upgraded.options.synchronize).toBe(false);
  });

  it('allows multiple social-only accounts with NULL local credentials and optional local pairs', async () => {
    const ids = [await account(), await account()];
    const rows = await runner.query(
      `SELECT id, login_id, password_hash, password_reset_required
       FROM accounts WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    expect(rows).toEqual(
      expect.arrayContaining(
        ids.map((id) => ({
          id,
          login_id: null,
          password_hash: null,
          password_reset_required: false,
        })),
      ),
    );
    expect(rows).toHaveLength(2);
    const id = await account(
      'optional-local-id',
      'optional-local-password-hash',
    );
    expect(
      await runner.query(
        'SELECT login_id, password_hash FROM accounts WHERE id = $1',
        [id],
      ),
    ).toEqual([
      {
        login_id: 'optional-local-id',
        password_hash: 'optional-local-password-hash',
      },
    ]);
    const columns = (await table('accounts')).columns;
    for (const name of ['login_id', 'password_hash']) {
      expect(columns.find((column) => column.name === name)).toMatchObject({
        type: 'character varying',
        isNullable: true,
      });
    }
  });

  it.each([
    ['id-only', null],
    [null, 'hash-only'],
  ])(
    'rejects partial local credentials (%s, %s)',
    async (loginId, passwordHash) => {
      await expectSqlError(
        `INSERT INTO accounts (login_id, name, email, password_hash)
       VALUES ($1, 'Partial credentials', $2, $3)`,
        [loginId, `${randomUUID()}@example.test`, passwordHash],
        '23514',
        'chk_accounts_local_credentials_pair',
      );
    },
  );

  it('rejects a reset requirement without local credentials on insert and update', async () => {
    await expectSqlError(
      `INSERT INTO accounts (name, email, password_reset_required)
       VALUES ('Invalid reset', $1, true)`,
      [`${randomUUID()}@example.test`],
      '23514',
      'chk_accounts_password_reset_local_credentials',
    );
    const id = await account();
    await expectSqlError(
      'UPDATE accounts SET password_reset_required = true WHERE id = $1',
      [id],
      '23514',
      'chk_accounts_password_reset_local_credentials',
    );
    await runner.query(
      'UPDATE accounts SET password_reset_required = true WHERE id = $1',
      [legacyAccount.id],
    );
  });

  it('preserves local login-ID and email uniqueness after allowing NULL credentials', async () => {
    await expectSqlError(
      `INSERT INTO accounts (login_id, name, email, password_hash)
       VALUES ($1, 'Duplicate login', $2, 'hash')`,
      [legacyAccount.login_id, `${randomUUID()}@example.test`],
      '23505',
    );
    await expectSqlError(
      "INSERT INTO accounts (name, email) VALUES ('Duplicate email', $1)",
      [legacyAccount.email],
      '23505',
    );
  });

  it('enforces social identity ownership and deletes identities with their account', async () => {
    const accountId = await account();
    const [identity] = await queryRows<{ id: string }>(
      `INSERT INTO social_identities (account_id, provider, provider_client_id, subject)
       VALUES ($1, 'google', 'client-id', 'subject') RETURNING id`,
      [accountId],
    );
    await expectSqlError(
      `INSERT INTO social_identities (account_id, provider, provider_client_id, subject)
       VALUES ($1, 'google', 'client-id', 'unknown-account')`,
      [randomUUID()],
      '23503',
    );
    await runner.query('DELETE FROM accounts WHERE id = $1', [accountId]);
    expect(
      await runner.query('SELECT id FROM social_identities WHERE id = $1', [
        identity.id,
      ]),
    ).toEqual([]);
    const identities = await table('social_identities');
    expect(identities.foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          columnNames: ['account_id'],
          referencedColumnNames: ['id'],
          onDelete: 'CASCADE',
        }),
      ]),
    );
    expect(identities.indices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'idx_social_identity_account',
          columnNames: ['account_id'],
        }),
      ]),
    );
  });

  it('makes provider/client/subject unique across accounts while allowing distinct identities', async () => {
    const first = await account();
    const second = await account();
    await runner.query(
      `INSERT INTO social_identities (account_id, provider, provider_client_id, subject)
       VALUES ($1, 'google', 'client-one', 'subject-one')`,
      [first],
    );
    for (const id of [first, second]) {
      await expectSqlError(
        `INSERT INTO social_identities (account_id, provider, provider_client_id, subject)
         VALUES ($1, 'google', 'client-one', 'subject-one')`,
        [id],
        '23505',
        'uq_social_identity_subject',
      );
    }
    for (const [provider, client, subject] of [
      ['future-provider', 'client-one', 'subject-one'],
      ['google', 'client-two', 'subject-one'],
      ['google', 'client-one', 'subject-two'],
    ]) {
      await runner.query(
        `INSERT INTO social_identities (account_id, provider, provider_client_id, subject)
         VALUES ($1, $2, $3, $4)`,
        [first, provider, client, subject],
      );
    }
    expect(
      await runner.query(
        'SELECT count(*)::int AS count FROM social_identities WHERE account_id = $1',
        [first],
      ),
    ).toEqual([{ count: 4 }]);
  });

  it('persists timezone-aware transaction expiry with an expiry index and unique token hashes', async () => {
    const expiresAt = new Date('2026-11-04T15:06:07.123Z');
    const [transaction] = await queryRows<{ id: string; expires_at: Date }>(
      `INSERT INTO social_login_transactions
        (token_hash, browser_binding_hash, provider, phase, data_json, expires_at)
       VALUES ('unique-token-hash', 'binding-hash', 'google', 'authorization', '{}', $1)
       RETURNING id, expires_at`,
      [expiresAt],
    );
    expect(transaction.expires_at).toEqual(expiresAt);
    const transactions = await table('social_login_transactions');
    expect(
      transactions.columns.find((column) => column.name === 'expires_at'),
    ).toMatchObject({ type: 'timestamp with time zone', isNullable: false });
    expect(transactions.indices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'idx_social_transaction_expiry',
          columnNames: ['expires_at'],
        }),
      ]),
    );
    await expectSqlError(
      `INSERT INTO social_login_transactions
        (token_hash, browser_binding_hash, provider, phase, data_json, expires_at)
       VALUES ('unique-token-hash', 'another-binding', 'naver', 'signup', '{}', $1)`,
      [expiresAt],
      '23505',
    );
    await expectSqlError(
      `INSERT INTO social_login_transactions
        (token_hash, browser_binding_hash, provider, phase, data_json, expires_at)
       VALUES ('another-token', 'binding', 'google', 'authorization', '{}', NULL)`,
      [],
      '23502',
    );
    for (const phase of ['processing', 'signup']) {
      await runner.query(
        'UPDATE social_login_transactions SET phase = $1 WHERE id = $2',
        [phase, transaction.id],
      );
    }
    await expectSqlError(
      'UPDATE social_login_transactions SET phase = $1 WHERE id = $2',
      ['invalid-phase', transaction.id],
      '23514',
      'chk_social_transaction_phase',
    );
  });

  it('backfills signup purpose and nullable context while preserving existing email verification data', async () => {
    expect(
      await runner.query('SELECT * FROM email_verifications WHERE id = $1', [
        legacyEmail.id,
      ]),
    ).toEqual([{ ...legacyEmail, purpose: 'signup', context_hash: null }]);
    const [verification] = await queryRows<{
      purpose: string;
      context_hash: string | null;
    }>(
      `INSERT INTO email_verifications (email, code_hash, expires_at)
       VALUES ('new-verification@example.test', 'code-hash', now())
       RETURNING purpose, context_hash`,
    );
    expect(verification).toEqual({ purpose: 'signup', context_hash: null });
    const [social] = await queryRows<{
      purpose: string;
      context_hash: string | null;
    }>(
      `INSERT INTO email_verifications (email, code_hash, expires_at, purpose, context_hash)
       VALUES ('social-verification@example.test', 'code-hash', now(), 'social', 'context-hash')
       RETURNING purpose, context_hash`,
    );
    expect(social).toEqual({ purpose: 'social', context_hash: 'context-hash' });
  });

  it('refuses the social-schema rollback while identities exist and preserves data/history', async () => {
    const [identity] = await queryRows<Record<string, unknown>>(
      `INSERT INTO social_identities (account_id, provider, provider_client_id, subject)
       VALUES ($1, 'google', 'rollback-client', 'rollback-subject') RETURNING *`,
      [legacyAccount.id],
    );
    const history = await migrationHistory();
    await runner.query('SAVEPOINT rollback_guard');
    await expect(
      new MigrationExecutor(upgraded, runner).undoLastMigration(),
    ).rejects.toThrow(/linked identities exist/i);
    await runner.query('ROLLBACK TO SAVEPOINT rollback_guard');
    expect(
      await runner.query('SELECT * FROM social_identities WHERE id = $1', [
        identity.id,
      ]),
    ).toEqual([identity]);
    expect(
      await runner.query('SELECT * FROM accounts WHERE id = $1', [
        legacyAccount.id,
      ]),
    ).toEqual([legacyAccount]);
    expect(await migrationHistory()).toEqual(history);
  });

  it('waits for an identity writer before checking the rollback guard and preserves its commit', async () => {
    const writer = upgraded.createQueryRunner();
    const identityId = randomUUID();
    let rollbackAttempt: Promise<unknown> | undefined;
    try {
      await runner.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await runner.query("SET LOCAL statement_timeout = '10s'");
      const history = await migrationHistory();
      const [{ pid: rollbackPid }] = await queryRows<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      await writer.connect();
      await writer.startTransaction();
      const [{ pid: writerPid }] = (await writer.query(
        'SELECT pg_backend_pid() AS pid',
      )) as Array<{ pid: number }>;
      const [identity] = (await writer.query(
        `INSERT INTO social_identities
          (id, account_id, provider, provider_client_id, subject)
         VALUES ($1, $2, 'google', 'concurrent-rollback-client', $3)
         RETURNING *`,
        [identityId, legacyAccount.id, randomUUID()],
      )) as Array<Record<string, unknown>>;
      rollbackAttempt = new AddSocialLogin20261104000001().down(runner).then(
        () => null,
        (error: unknown) => error,
      );

      let blocked = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [{ waiting }] = await upgraded.query<Array<{ waiting: boolean }>>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE pid = $1 AND wait_event_type = 'Lock'
               AND query = 'LOCK TABLE social_identities IN ACCESS EXCLUSIVE MODE'
               AND $2 = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
          [rollbackPid, writerPid],
        );
        if (waiting) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await writer.commitTransaction();
      expect(await rollbackAttempt).toMatchObject({
        message: expect.stringMatching(/linked identities exist/i),
      });
      expect(
        await runner.query('SELECT * FROM social_identities WHERE id = $1', [
          identityId,
        ]),
      ).toEqual([identity]);
      expect(await migrationHistory()).toEqual(history);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      if (rollbackAttempt) await rollbackAttempt;
      // Release the rollback's table lock before deleting the committed fixture.
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (!writer.isReleased) await writer.release();
      await upgraded.query('DELETE FROM social_identities WHERE id = $1', [
        identityId,
      ]);
    }
  }, 15000);

  it('refuses the credential rollback while social-only accounts exist without fabricating credentials', async () => {
    const executor = new MigrationExecutor(upgraded, runner);
    await executor.undoLastMigration();
    const id = await account();
    const history = await migrationHistory();
    expect(history.at(-1)).toBe(SOCIAL_MIGRATIONS[0]);
    await runner.query('SAVEPOINT rollback_guard');
    await expect(executor.undoLastMigration()).rejects.toThrow(
      /social-only accounts exist/i,
    );
    await runner.query('ROLLBACK TO SAVEPOINT rollback_guard');
    expect(
      await runner.query(
        'SELECT login_id, password_hash FROM accounts WHERE id = $1',
        [id],
      ),
    ).toEqual([{ login_id: null, password_hash: null }]);
    expect(
      await runner.query('SELECT * FROM accounts WHERE id = $1', [
        legacyAccount.id,
      ]),
    ).toEqual([legacyAccount]);
    expect(await migrationHistory()).toEqual(history);
    expect(
      (await table('accounts')).columns.find(
        (column) => column.name === 'login_id',
      )?.isNullable,
    ).toBe(true);
  });

  it('can revert both migrations when no linked or social-only accounts exist', async () => {
    const executor = new MigrationExecutor(upgraded, runner);
    await executor.undoLastMigration();
    await executor.undoLastMigration();
    expect(await migrationHistory()).toEqual(legacyMigrationNames);
    expect(await runner.hasTable('public.social_identities')).toBe(false);
    expect(await runner.hasTable('public.social_login_transactions')).toBe(
      false,
    );
    for (const name of ['login_id', 'password_hash']) {
      expect(
        (await table('accounts')).columns.find((column) => column.name === name)
          ?.isNullable,
      ).toBe(false);
    }
    expect(
      (await table('email_verifications')).columns.map((column) => column.name),
    ).not.toEqual(expect.arrayContaining(['purpose', 'context_hash']));
    expect(
      await runner.query('SELECT * FROM accounts WHERE id = $1', [
        legacyAccount.id,
      ]),
    ).toEqual([legacyAccount]);
    expect(
      await runner.query('SELECT * FROM email_verifications WHERE id = $1', [
        legacyEmail.id,
      ]),
    ).toEqual([legacyEmail]);
  });
});
