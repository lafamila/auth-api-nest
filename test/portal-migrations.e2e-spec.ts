import 'reflect-metadata';
import { join } from 'node:path';
import { DataSource, MigrationExecutor } from 'typeorm';

const PORTAL_MIGRATION = 'AddAccountCredentialVersion20261116000000';

function isolatedDatabase(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !database.startsWith('auth_portal_migrations_') ||
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

describe('Portal migration database safety gate', () => {
  it.each([
    undefined,
    '',
    'not-a-database-url',
    'postgres://localhost/teddy_auth',
    'postgres://localhost/other_auth_portal_migrations_test',
    'mysql://localhost/auth_portal_migrations_test',
    'postgres://localhost/auth_portal_migrations_test/other',
    'postgres://localhost/auth_portal_migrations_test%2Fother',
    'postgres://localhost/auth_portal_migrations_test?database=teddy_auth',
    'postgres://localhost/auth_portal_migrations_test?dbname=teddy_auth',
  ])('does not enable database tests for %s', (value) => {
    expect(isolatedDatabase(value)).toBeNull();
  });

  it.each(['postgres', 'postgresql'])(
    'accepts an explicitly isolated %s database',
    (protocol) => {
      const url = `${protocol}://localhost/auth_portal_migrations_test`;
      expect(isolatedDatabase(url)).toEqual({
        url,
        database: 'auth_portal_migrations_test',
      });
    },
  );
});

// Never fall back to DATABASE_URL or the application e2e database.
const database = isolatedDatabase(process.env.PORTAL_MIGRATION_DATABASE_URL);
const describeDatabase = database ? describe : describe.skip;

describeDatabase('Portal credential version real migration (e2e)', () => {
  let legacy: DataSource;
  let upgraded: DataSource;
  let legacyAccount: Record<string, unknown>;
  let legacyAdminSession: Record<string, unknown>;
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
      applicationName: 'portal-migrations-e2e',
    });
  }

  async function migrationHistory(source: DataSource): Promise<string[]> {
    const rows = await source.query<Array<{ name: string }>>(
      'SELECT name FROM migrations ORDER BY id',
    );
    return rows.map((row) => row.name);
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

    const withheld = legacy.migrations.filter(
      (migration) =>
        (migration.name ?? migration.constructor.name) === PORTAL_MIGRATION,
    );
    expect(withheld.map((migration) => migration.name)).toEqual([
      PORTAL_MIGRATION,
    ]);
    const oldMigrations = legacy.migrations.filter(
      (migration) => !withheld.includes(migration),
    );
    legacy.migrations.splice(0, legacy.migrations.length, ...oldMigrations);
    const applied = await legacy.runMigrations({ transaction: 'all' });
    legacyMigrationNames = applied.map((migration) => migration.name);
    expect(applied).toHaveLength(oldMigrations.length);
    expect(legacyMigrationNames).not.toContain(PORTAL_MIGRATION);

    [legacyAccount] = await legacy.query<Array<Record<string, unknown>>>(
      `INSERT INTO accounts
        (login_id, name, email, password_hash, status, is_super_admin,
         password_reset_required, email_verified_at, last_login_at,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        'portal-migration-admin',
        'Existing portal admin',
        'portal-migration-admin@example.test',
        'existing-portal-password-hash',
        'active',
        true,
        false,
        new Date('2026-11-01T01:02:03.000Z'),
        new Date('2026-11-02T04:05:06.000Z'),
        new Date('2026-11-03T07:08:09.000Z'),
        new Date('2026-11-04T10:11:12.000Z'),
      ],
    );
    [legacyAdminSession] = await legacy.query<Array<Record<string, unknown>>>(
      `INSERT INTO admin_sessions
        (account_id, token_hash, idle_expires_at, absolute_expires_at,
         last_seen_at, revoked_at, ip_address, user_agent, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        legacyAccount.id,
        'existing-portal-admin-session-token-hash',
        new Date('2026-11-05T01:00:00.000Z'),
        new Date('2026-11-05T12:00:00.000Z'),
        new Date('2026-11-05T00:30:00.000Z'),
        null,
        '192.0.2.10',
        'portal-migration-e2e',
        new Date('2026-11-05T00:00:00.000Z'),
        new Date('2026-11-05T00:30:00.000Z'),
      ],
    );
    await legacy.destroy();

    upgraded = migrationSource();
    await upgraded.initialize();
    const pending = await new MigrationExecutor(
      upgraded,
    ).getPendingMigrations();
    expect(pending.map((migration) => migration.name)).toEqual([
      PORTAL_MIGRATION,
    ]);
    const newMigrations = await upgraded.runMigrations({ transaction: 'all' });
    expect(newMigrations.map((migration) => migration.name)).toEqual([
      PORTAL_MIGRATION,
    ]);
    expect(await upgraded.showMigrations()).toBe(false);
  }, 60000);

  afterAll(async () => {
    // The coordinator owns this database's disposal; never drop or reset it here.
    if (upgraded?.isInitialized) await upgraded.destroy();
    if (legacy?.isInitialized) await legacy.destroy();
  });

  it('preserves existing account credentials and admin session data while backfilling version zero', async () => {
    const accounts = await upgraded.query<Array<Record<string, unknown>>>(
      'SELECT * FROM accounts WHERE id = $1',
      [legacyAccount.id],
    );
    const sessions = await upgraded.query<Array<Record<string, unknown>>>(
      'SELECT * FROM admin_sessions WHERE id = $1',
      [legacyAdminSession.id],
    );

    expect(accounts).toEqual([{ ...legacyAccount, credential_version: 0 }]);
    expect(sessions).toEqual([
      { ...legacyAdminSession, credential_version: 0 },
    ]);
    expect(accounts[0]).toMatchObject({
      login_id: 'portal-migration-admin',
      password_hash: 'existing-portal-password-hash',
    });
    expect(await migrationHistory(upgraded)).toEqual([
      ...legacyMigrationNames,
      PORTAL_MIGRATION,
    ]);
    expect(upgraded.options.synchronize).toBe(false);
  });

  it.each([
    ['accounts', () => legacyAccount.id],
    ['admin_sessions', () => legacyAdminSession.id],
  ])(
    'blocks rollback after %s advances to a new credential version',
    async (table, id) => {
      await upgraded.query(
        `UPDATE ${table} SET credential_version = 1 WHERE id = $1`,
        [id()],
      );
      try {
        await expect(
          upgraded.undoLastMigration({ transaction: 'all' }),
        ).rejects.toThrow(
          'Cannot revert AddAccountCredentialVersion after credentials have changed',
        );
        expect(
          await upgraded.query(
            `SELECT credential_version FROM ${table} WHERE id = $1`,
            [id()],
          ),
        ).toEqual([{ credential_version: 1 }]);
        expect(await migrationHistory(upgraded)).toEqual([
          ...legacyMigrationNames,
          PORTAL_MIGRATION,
        ]);
        expect(await upgraded.showMigrations()).toBe(false);
      } finally {
        await upgraded.query(
          `UPDATE ${table} SET credential_version = 0 WHERE id = $1`,
          [id()],
        );
      }
    },
  );
});
