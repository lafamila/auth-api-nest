import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowPreAuthTokenRecords20260820000000 implements MigrationInterface {
  name = 'AllowPreAuthTokenRecords20260820000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE token_records
      ALTER COLUMN account_id DROP NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM token_records
      WHERE type = 'authorization_login'
    `);
    await queryRunner.query(`
      ALTER TABLE token_records
      ALTER COLUMN account_id SET NOT NULL
    `);
  }
}
