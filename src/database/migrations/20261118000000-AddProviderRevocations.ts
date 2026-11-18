import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProviderRevocations20261118000000 implements MigrationInterface {
  name = 'AddProviderRevocations20261118000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE social_identities ADD COLUMN encrypted_revocation_grant text NULL',
    );
    await queryRunner.query(`
      CREATE TABLE provider_revocation_jobs (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        reason varchar(24) NOT NULL CHECK (reason IN ('unlink', 'withdraw')),
        status varchar(24) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'retry', 'succeeded', 'manual_required')),
        target_hash varchar(64) NOT NULL CHECK (target_hash ~ '^[a-f0-9]{64}$'),
        encrypted_payload text NULL,
        attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
        next_attempt_at timestamptz NULL DEFAULT now(),
        deadline_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
        lease_token uuid NULL,
        lease_expires_at timestamptz NULL,
        last_error_code varchar(40) NULL,
        completed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (deadline_at <= created_at + interval '24 hours'),
        CHECK (status NOT IN ('succeeded', 'manual_required') OR encrypted_payload IS NULL)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_provider_revocations_due ON provider_revocation_jobs(status, next_attempt_at)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_provider_revocations_target ON provider_revocation_jobs(target_hash, status)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) {
      throw new Error(
        'Provider revocation rollback requires an active transaction',
      );
    }
    await queryRunner.query(
      'LOCK TABLE provider_revocation_jobs IN ACCESS EXCLUSIVE MODE',
    );
    const rows = (await queryRunner.query(
      'SELECT 1 FROM provider_revocation_jobs WHERE encrypted_payload IS NOT NULL LIMIT 1',
    )) as unknown[];
    if (rows.length)
      throw new Error('Cannot discard pending provider revocations');
    await queryRunner.query(
      'LOCK TABLE social_identities IN ACCESS EXCLUSIVE MODE',
    );
    const grants = (await queryRunner.query(
      'SELECT 1 FROM social_identities WHERE encrypted_revocation_grant IS NOT NULL LIMIT 1',
    )) as unknown[];
    if (grants.length)
      throw new Error('Cannot discard retained provider revocation grants');
    await queryRunner.query('DROP TABLE provider_revocation_jobs');
    await queryRunner.query(
      'ALTER TABLE social_identities DROP COLUMN encrypted_revocation_grant',
    );
  }
}
