import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddServiceApplications20260521000001 implements MigrationInterface {
  name = 'AddServiceApplications20260521000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS service_applications (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        account_id uuid NOT NULL REFERENCES accounts(id),
        service_id uuid NOT NULL REFERENCES services(id),
        message text NOT NULL DEFAULT '',
        status varchar NOT NULL DEFAULT 'pending',
        target_permission_definition_id uuid REFERENCES service_permission_definitions(id),
        reviewed_by_account_id uuid REFERENCES accounts(id),
        reviewed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_service_applications_pending
      ON service_applications(service_id, account_id, status)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_service_applications_one_pending
      ON service_applications(account_id, service_id)
      WHERE status = 'pending'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_service_applications_one_pending`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_service_applications_pending`);
    await queryRunner.query(`DROP TABLE IF EXISTS service_applications`);
  }
}
