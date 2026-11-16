import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAccountCredentialVersion20261116000000 implements MigrationInterface {
  name = 'AddAccountCredentialVersion20261116000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE accounts
      ADD COLUMN credential_version integer NOT NULL DEFAULT 0,
      ADD CONSTRAINT chk_accounts_credential_version_nonnegative
        CHECK (credential_version >= 0);

      ALTER TABLE admin_sessions
      ADD COLUMN credential_version integer NOT NULL DEFAULT 0
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        LOCK TABLE accounts, admin_sessions IN ACCESS EXCLUSIVE MODE;
        IF EXISTS (SELECT 1 FROM accounts WHERE credential_version > 0)
          OR EXISTS (SELECT 1 FROM admin_sessions WHERE credential_version > 0) THEN
          RAISE EXCEPTION 'Cannot revert AddAccountCredentialVersion after credentials have changed';
        END IF;

        ALTER TABLE accounts
        DROP CONSTRAINT chk_accounts_credential_version_nonnegative,
        DROP COLUMN credential_version;

        ALTER TABLE admin_sessions DROP COLUMN credential_version;
      END;
      $$;
    `);
  }
}
