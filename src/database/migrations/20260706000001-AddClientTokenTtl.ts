import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClientTokenTtl20260706000001 implements MigrationInterface {
  name = 'AddClientTokenTtl20260706000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE oidc_clients
      ADD COLUMN IF NOT EXISTS access_token_ttl_seconds integer,
      ADD COLUMN IF NOT EXISTS refresh_token_ttl_seconds integer
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE oidc_clients
      DROP COLUMN IF EXISTS access_token_ttl_seconds,
      DROP COLUMN IF EXISTS refresh_token_ttl_seconds
    `);
  }
}
