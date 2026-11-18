import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { QueryRunner } from 'typeorm';
import { AddProviderRevocations20261118000000 } from '../database/migrations/20261118000000-AddProviderRevocations';
import { ProviderRevocationsModule } from './provider-revocations.module';
import { ProviderRevocationsService } from './provider-revocations.service';

describe('Provider revocation module and migration contract', () => {
  it('exports the lifecycle service for the account mutation owner', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, ProviderRevocationsModule),
    ).toContain(ProviderRevocationsService);
  });

  it('adds a nullable grant without fabricating legacy tokens and creates a standalone bounded outbox', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AddProviderRevocations20261118000000().up({
      query,
    } as unknown as QueryRunner);
    const sql = query.mock.calls
      .map(([statement]) => statement as string)
      .join('\n');
    expect(sql).toContain('ADD COLUMN encrypted_revocation_grant text NULL');
    expect(sql).toContain('attempts BETWEEN 0 AND 8');
    expect(sql).toContain(
      "target_hash varchar(64) NOT NULL CHECK (target_hash ~ '^[a-f0-9]{64}$')",
    );
    expect(sql).toContain('provider_revocation_jobs(target_hash, status)');
    expect(sql).toContain("deadline_at <= created_at + interval '24 hours'");
    expect(sql).toContain(
      "status NOT IN ('succeeded', 'manual_required') OR encrypted_payload IS NULL",
    );
    expect(sql).not.toContain('REFERENCES accounts');
    expect(sql).not.toContain('account_id');
    expect(sql).not.toContain('subject');
    expect(sql).not.toContain('UPDATE social_identities');
  });

  it('refuses rollback that would discard unfinished provider revocations', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ exists: 1 }]);
    await expect(
      new AddProviderRevocations20261118000000().down({
        query,
        isTransactionActive: true,
      } as unknown as QueryRunner),
    ).rejects.toThrow('Cannot discard pending provider revocations');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('requires transactional rollback and drops the outbox before its grant column', async () => {
    const migration = new AddProviderRevocations20261118000000();
    await expect(
      migration.down({ isTransactionActive: false } as QueryRunner),
    ).rejects.toThrow('active transaction');
    const query = jest.fn().mockResolvedValue([]);
    await migration.down({
      query,
      isTransactionActive: true,
    } as unknown as QueryRunner);
    expect(query.mock.calls[2][0]).toBe(
      'LOCK TABLE social_identities IN ACCESS EXCLUSIVE MODE',
    );
    expect(query.mock.calls[4][0]).toBe('DROP TABLE provider_revocation_jobs');
    expect(query.mock.calls[5][0]).toBe(
      'ALTER TABLE social_identities DROP COLUMN encrypted_revocation_grant',
    );
  });
});
