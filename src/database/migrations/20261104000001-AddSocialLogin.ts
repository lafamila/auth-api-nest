import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSocialLogin20261104000001 implements MigrationInterface {
  name = 'AddSocialLogin20261104000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE social_identities (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider varchar(40) NOT NULL,
        provider_client_id varchar(512) NOT NULL,
        subject varchar(255) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_social_identity_subject UNIQUE (provider, provider_client_id, subject)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_social_identity_account ON social_identities(account_id)',
    );
    await queryRunner.query(`
      CREATE TABLE social_login_transactions (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        token_hash varchar NOT NULL UNIQUE,
        browser_binding_hash varchar NOT NULL,
        provider varchar(40) NOT NULL,
        phase varchar NOT NULL,
        data_json jsonb NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_social_transaction_phase
          CHECK (phase IN ('authorization', 'processing', 'signup'))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_social_transaction_expiry ON social_login_transactions(expires_at)',
    );
    await queryRunner.query(
      "ALTER TABLE email_verifications ADD COLUMN purpose varchar NOT NULL DEFAULT 'signup'",
    );
    await queryRunner.query(
      'ALTER TABLE email_verifications ADD COLUMN context_hash varchar NULL',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) {
      throw new Error('Social login rollback requires an active transaction');
    }
    await queryRunner.query(
      'LOCK TABLE social_identities IN ACCESS EXCLUSIVE MODE',
    );
    const rows = (await queryRunner.query(
      'SELECT count(*)::int AS count FROM social_identities',
    )) as Array<{ count: number }>;
    if (rows[0]?.count) {
      throw new Error(
        'Cannot remove social login while linked identities exist',
      );
    }
    await queryRunner.query(
      "DELETE FROM email_verifications WHERE purpose = 'social'",
    );
    await queryRunner.query(
      'ALTER TABLE email_verifications DROP COLUMN context_hash',
    );
    await queryRunner.query(
      'ALTER TABLE email_verifications DROP COLUMN purpose',
    );
    await queryRunner.query('DROP TABLE social_login_transactions');
    await queryRunner.query('DROP TABLE social_identities');
  }
}
