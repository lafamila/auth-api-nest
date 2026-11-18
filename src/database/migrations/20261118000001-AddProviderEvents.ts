import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProviderEvents20261118000001 implements MigrationInterface {
  name = 'AddProviderEvents20261118000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE provider_events (
        id uuid PRIMARY KEY,
        provider varchar(16) NOT NULL,
        dedup_hash varchar(64) NOT NULL,
        encrypted_target text NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        lease_token uuid NULL,
        lease_until timestamptz NULL,
        CONSTRAINT uq_provider_event_dedup UNIQUE (provider, dedup_hash),
        CONSTRAINT chk_provider_event_provider CHECK (provider IN ('naver', 'kakao', 'google')),
        CONSTRAINT chk_provider_event_attempts CHECK (attempts >= 0),
        CONSTRAINT chk_provider_event_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
        CONSTRAINT chk_provider_event_payload CHECK (
          (processed_at IS NULL AND encrypted_target IS NOT NULL)
          OR (processed_at IS NOT NULL AND encrypted_target IS NULL)
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_provider_event_due ON provider_events (next_attempt_at, lease_until)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_provider_event_expiry ON provider_events (expires_at)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) {
      throw new Error('Provider event rollback requires a transaction');
    }
    await queryRunner.query(
      'LOCK TABLE provider_events IN ACCESS EXCLUSIVE MODE',
    );
    const rows = (await queryRunner.query(
      'SELECT count(*)::integer AS count FROM provider_events WHERE processed_at IS NULL',
    )) as Array<{ count: number }>;
    if (rows[0]?.count) {
      throw new Error('Cannot discard unprocessed provider events');
    }
    await queryRunner.query('DROP TABLE provider_events');
  }
}
