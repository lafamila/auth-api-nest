import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowSocialOnlyAccounts20261104000000 implements MigrationInterface {
  name = 'AllowSocialOnlyAccounts20261104000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE accounts
      ALTER COLUMN login_id DROP NOT NULL,
      ALTER COLUMN password_hash DROP NOT NULL,
      ADD CONSTRAINT chk_accounts_local_credentials_pair
        CHECK ((login_id IS NULL) = (password_hash IS NULL)),
      ADD CONSTRAINT chk_accounts_password_reset_local_credentials
        CHECK (password_hash IS NOT NULL OR NOT password_reset_required)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM accounts
          WHERE login_id IS NULL OR password_hash IS NULL
        ) THEN
          RAISE EXCEPTION 'Cannot revert AllowSocialOnlyAccounts while social-only accounts exist';
        END IF;

        ALTER TABLE accounts
        ALTER COLUMN login_id SET NOT NULL,
        ALTER COLUMN password_hash SET NOT NULL,
        DROP CONSTRAINT chk_accounts_local_credentials_pair,
        DROP CONSTRAINT chk_accounts_password_reset_local_credentials;
      END;
      $$;
    `);
  }
}
