import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddServiceCategories20261118000003 implements MigrationInterface {
  name = 'AddServiceCategories20261118000003';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE services
      ADD COLUMN category varchar NOT NULL DEFAULT 'other',
      ADD CONSTRAINT chk_services_category CHECK (category IN (
        'game', 'productivity', 'education', 'community', 'communication',
        'content', 'travel', 'health', 'finance', 'commerce', 'developer_tools', 'other'
      ))`);
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error(
        'Service category rollback requires an active transaction',
      );
    await runner.query('LOCK TABLE services IN ACCESS EXCLUSIVE MODE');
    const configured = (await runner.query(
      "SELECT 1 FROM services WHERE category <> 'other' LIMIT 1",
    )) as unknown[];
    if (configured.length)
      throw new Error(
        'Cannot remove configured service login-policy categories',
      );
    await runner.query(`ALTER TABLE services
      DROP CONSTRAINT chk_services_category,
      DROP COLUMN category`);
  }
}
