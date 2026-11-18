import { QueryRunner } from 'typeorm';
import { AddAccountPolicyConsents20261118000002 } from '../database/migrations/20261118000002-AddAccountPolicyConsents';

describe('Policy consent migration preservation', () => {
  it('creates only the consent table without inventing historical account acceptance', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AddAccountPolicyConsents20261118000002().up({
      query,
    } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('CREATE TABLE account_policy_consents');
    expect(sql).toContain('REFERENCES accounts(id) ON DELETE CASCADE');
    expect(sql).toContain(
      'UNIQUE (account_id, terms_version, privacy_version, policy_digest)',
    );
    expect(sql).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO\s+|FROM\s+)?accounts\b/i,
    );
    expect(sql).not.toMatch(/INSERT\s+INTO\s+account_policy_consents/i);
  });

  it('refuses a nontransactional rollback before querying or deleting evidence', async () => {
    const query = jest.fn();
    await expect(
      new AddAccountPolicyConsents20261118000002().down({
        query,
        isTransactionActive: false,
      } as unknown as QueryRunner),
    ).rejects.toThrow('active transaction');
    expect(query).not.toHaveBeenCalled();
  });

  it('locks and preserves recorded consent instead of dropping nonempty evidence', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ exists: true }]);
    await expect(
      new AddAccountPolicyConsents20261118000002().down({
        query,
        isTransactionActive: true,
      } as unknown as QueryRunner),
    ).rejects.toThrow('Cannot discard');
    expect(query.mock.calls.map(([sql]) => sql as string)).toEqual([
      'LOCK TABLE account_policy_consents IN ACCESS EXCLUSIVE MODE',
      'SELECT EXISTS(SELECT 1 FROM account_policy_consents) AS exists',
    ]);
  });

  it('permits an empty-table rollback only after taking the exclusive lock', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ exists: false }])
      .mockResolvedValueOnce([]);
    await new AddAccountPolicyConsents20261118000002().down({
      query,
      isTransactionActive: true,
    } as unknown as QueryRunner);
    expect(query.mock.calls.map(([sql]) => sql as string)).toEqual([
      'LOCK TABLE account_policy_consents IN ACCESS EXCLUSIVE MODE',
      'SELECT EXISTS(SELECT 1 FROM account_policy_consents) AS exists',
      'DROP TABLE account_policy_consents',
    ]);
  });
});
