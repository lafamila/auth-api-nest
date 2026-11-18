import { QueryRunner } from 'typeorm';
import { AddProviderEvents20261118000001 } from '../../database/migrations/20261118000001-AddProviderEvents';

describe('AddProviderEvents20261118000001 offline migration contract', () => {
  const migration = new AddProviderEvents20261118000001();
  it('creates the durable unique receipt fence, encrypted-only payload and queue/expiry indexes', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await migration.up({ query } as unknown as QueryRunner);
    const statements = query.mock.calls
      .map(([sql]: [string]) => sql)
      .join('\n');
    expect(statements).toContain('UNIQUE (provider, dedup_hash)');
    expect(statements).toContain('encrypted_target text NULL');
    expect(statements).toContain('idx_provider_event_due');
    expect(statements).toContain('idx_provider_event_expiry');
    expect(statements).not.toMatch(/email|subject|raw_payload|access_token/);
  });

  it('refuses rollback without a transaction', async () => {
    const query = jest.fn();
    await expect(
      migration.down({
        query,
        isTransactionActive: false,
      } as unknown as QueryRunner),
    ).rejects.toThrow('requires a transaction');
    expect(query).not.toHaveBeenCalled();
  });

  it('locks and refuses to discard pending work', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 1 }]);
    await expect(
      migration.down({
        query,
        isTransactionActive: true,
      } as unknown as QueryRunner),
    ).rejects.toThrow('unprocessed');
    expect(query.mock.calls[0][0]).toContain('ACCESS EXCLUSIVE');
    expect(query.mock.calls).toHaveLength(2);
  });

  it('can roll back a drained receipt table inside a transaction', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValue([]);
    await migration.down({
      query,
      isTransactionActive: true,
    } as unknown as QueryRunner);
    expect(query).toHaveBeenLastCalledWith('DROP TABLE provider_events');
  });
});
