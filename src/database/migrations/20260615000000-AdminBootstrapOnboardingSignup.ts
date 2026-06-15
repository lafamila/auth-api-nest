import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminBootstrapOnboardingSignup20260615000000
  implements MigrationInterface
{
  name = 'AdminBootstrapOnboardingSignup20260615000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS password_reset_required boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS email_verified_at timestamptz
    `);
    await queryRunner.query(`
      CREATE TABLE admin_bootstrap_challenges (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        login_id varchar NOT NULL,
        name varchar NOT NULL,
        email varchar NOT NULL,
        password_hash varchar NOT NULL,
        encrypted_otp_secret text NOT NULL,
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_admin_bootstrap_challenges_login_id
      ON admin_bootstrap_challenges(login_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_admin_bootstrap_challenges_email
      ON admin_bootstrap_challenges(email)
    `);
    await queryRunner.query(`
      CREATE TABLE admin_mfa (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
        encrypted_otp_secret text NOT NULL,
        algorithm varchar NOT NULL DEFAULT 'SHA1',
        digits integer NOT NULL DEFAULT 6,
        period integer NOT NULL DEFAULT 30,
        verified_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE admin_sessions (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash varchar NOT NULL UNIQUE,
        idle_expires_at timestamptz NOT NULL,
        absolute_expires_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL,
        revoked_at timestamptz,
        ip_address varchar,
        user_agent text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE service_onboarding_requests (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_key varchar NOT NULL,
        kind varchar NOT NULL DEFAULT 'create',
        status varchar NOT NULL DEFAULT 'pending',
        revision integer NOT NULL DEFAULT 1,
        request_secret_hash varchar NOT NULL,
        requester_name varchar,
        requester_email varchar,
        requested_spec_json jsonb NOT NULL,
        approved_snapshot_json jsonb,
        decision_reason text,
        decided_by_account_id uuid,
        decided_at timestamptz,
        request_ip varchar,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_service_onboarding_requests_service_key
      ON service_onboarding_requests(service_key)
    `);
    await queryRunner.query(`
      CREATE TABLE email_verifications (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        email varchar NOT NULL,
        code_hash varchar NOT NULL,
        request_ip varchar,
        attempt_count integer NOT NULL DEFAULT 0,
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_email_verifications_email ON email_verifications(email)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE email_verifications`);
    await queryRunner.query(`DROP TABLE service_onboarding_requests`);
    await queryRunner.query(`DROP TABLE admin_sessions`);
    await queryRunner.query(`DROP TABLE admin_mfa`);
    await queryRunner.query(`DROP TABLE admin_bootstrap_challenges`);
    await queryRunner.query(`
      ALTER TABLE accounts
      DROP COLUMN IF EXISTS email_verified_at,
      DROP COLUMN IF EXISTS password_reset_required
    `);
  }
}
