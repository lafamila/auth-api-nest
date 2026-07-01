import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowPublicSignupAuditLogs20260701000000 implements MigrationInterface {
  name = 'AllowPublicSignupAuditLogs20260701000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE audit_logs
      ALTER COLUMN actor_account_id DROP NOT NULL,
      ALTER COLUMN target_id DROP NOT NULL,
      ALTER COLUMN before_json DROP NOT NULL,
      ALTER COLUMN after_json DROP NOT NULL,
      ALTER COLUMN ip_address DROP NOT NULL,
      ALTER COLUMN user_agent DROP NOT NULL
    `);
  }

  async down(): Promise<void> {
    // Public signup audit rows intentionally have no actor account.
  }
}
