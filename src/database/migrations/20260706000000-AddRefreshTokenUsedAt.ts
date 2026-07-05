import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRefreshTokenUsedAt20260706000000 implements MigrationInterface {
  name = 'AddRefreshTokenUsedAt20260706000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE token_records
      ADD COLUMN IF NOT EXISTS used_at timestamptz
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE token_records
      DROP COLUMN IF EXISTS used_at
    `);
  }
}
