import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddServiceCredentials20260524000002 implements MigrationInterface {
  name = 'AddServiceCredentials20260524000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS service_credentials (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_id uuid NOT NULL REFERENCES services(id),
        key_id varchar NOT NULL UNIQUE,
        secret_hash varchar NOT NULL,
        name varchar NOT NULL,
        description text NOT NULL DEFAULT '',
        scopes text[] NOT NULL DEFAULT '{}',
        status varchar NOT NULL DEFAULT 'active',
        expires_at timestamptz,
        last_used_at timestamptz,
        last_used_from varchar,
        rotated_at timestamptz,
        disabled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_service_credentials_service_status
      ON service_credentials(service_id, status, created_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_service_credentials_service_status`);
    await queryRunner.query(`DROP TABLE IF EXISTS service_credentials`);
  }
}
