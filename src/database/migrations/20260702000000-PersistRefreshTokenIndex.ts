import { MigrationInterface, QueryRunner } from 'typeorm';

export class PersistRefreshTokenIndex20260702000000 implements MigrationInterface {
  name = 'PersistRefreshTokenIndex20260702000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_token_records_token_hash_unique
      ON token_records(token_hash)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_token_records_token_hash_unique
    `);
  }
}
