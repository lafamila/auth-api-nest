import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAccountPolicyConsents20261118000002 implements MigrationInterface {
  name = 'AddAccountPolicyConsents20261118000002';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE account_policy_consents (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      terms_version varchar(64) NOT NULL,
      privacy_version varchar(64) NOT NULL,
      policy_digest varchar(64) NOT NULL,
      source varchar(32) NOT NULL CHECK (source IN ('signup','social_signup','portal')),
      accepted_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_account_policy_consents UNIQUE (account_id, terms_version, privacy_version, policy_digest)
    )`);
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Policy consent rollback requires an active transaction');
    await runner.query(
      'LOCK TABLE account_policy_consents IN ACCESS EXCLUSIVE MODE',
    );
    const rows = (await runner.query(
      'SELECT EXISTS(SELECT 1 FROM account_policy_consents) AS exists',
    )) as Array<{ exists: boolean }>;
    if (rows[0]?.exists)
      throw new Error('Cannot discard recorded account policy consents');
    await runner.query('DROP TABLE account_policy_consents');
  }
}
