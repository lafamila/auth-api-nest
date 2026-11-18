import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { ProviderRevocationsService } from '../social/provider-revocations.service';
import { PrivacyRetentionService } from './privacy-retention.service';
import { privacyRetentionSettings } from './privacy-retention.settings';

function fixture(locked = true) {
  const builder = {
    where: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    setOnLocked: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const query = jest
    .fn<Promise<unknown[]>, [string, unknown[]?]>()
    .mockResolvedValue([])
    .mockResolvedValueOnce([{ locked }]);
  const manager = {
    query,
    getRepository: jest.fn(() => ({ createQueryBuilder: () => builder })),
    delete: jest.fn(),
    exists: jest.fn().mockResolvedValue(false),
  };
  const source = {
    transaction: jest.fn(
      async (run: (manager: EntityManager) => Promise<void>) =>
        run(manager as unknown as EntityManager),
    ),
  };
  const revocations = {
    prepare: jest.fn(),
    enqueue: jest.fn().mockResolvedValue(1),
  };
  const config = new ConfigService({ NODE_ENV: 'test' });
  const service = new PrivacyRetentionService(
    source as unknown as DataSource,
    config,
    revocations as unknown as ProviderRevocationsService,
  );
  return { service, source, query, builder, manager, revocations };
}

describe('Auth privacy retention', () => {
  it('shares the publicly disclosed defaults and rejects invalid settings', () => {
    expect(privacyRetentionSettings(new ConfigService())).toEqual({
      authDataRetentionHours: 1,
      auditRetentionDays: 30,
      backupRetentionDays: 7,
    });
    expect(() =>
      privacyRetentionSettings(
        new ConfigService({ AUTH_PRIVACY_AUTH_DATA_RETENTION_HOURS: '0' }),
      ),
    ).toThrow();
    expect(() =>
      privacyRetentionSettings(
        new ConfigService({ AUTH_PRIVACY_AUDIT_RETENTION_DAYS: '-1' }),
      ),
    ).toThrow();
  });
  it('cleans expired auth records and thirty-day logs without deleting accounts or backup files', async () => {
    const f = fixture();
    await f.service.processOnce();
    expect(f.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM email_verifications'),
      [1],
    );
    expect(f.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM audit_logs'),
      [30],
    );
    expect(f.query).toHaveBeenCalledWith(
      'DELETE FROM token_records WHERE expires_at <= now()',
    );
    expect(f.query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
      /DELETE FROM (accounts|services|oidc_clients)\b/,
    );
  });
  it('does not compete with another cleanup instance', async () => {
    const f = fixture(false);
    await f.service.processOnce();
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.builder.getMany).not.toHaveBeenCalled();
  });
  it('revokes an abandoned social signup grant before erasing the temporary record', async () => {
    const f = fixture();
    f.builder.getMany.mockResolvedValue([
      {
        id: 'expired',
        data: {
          profile: {
            provider: 'google',
            providerClientId: 'client',
            subject: 'subject',
            encryptedRevocationGrant: 'server-ciphertext',
          },
        },
      },
    ]);
    await f.service.processOnce();
    expect(f.revocations.enqueue).toHaveBeenCalledWith(
      f.manager,
      [
        expect.objectContaining({
          encryptedRevocationGrant: 'server-ciphertext',
        }),
      ],
      'unlink',
    );
    expect(f.revocations.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      f.manager.delete.mock.invocationCallOrder[0],
    );
  });
  it('does not revoke a signup identity which was completed in another tab', async () => {
    const f = fixture();
    f.manager.exists.mockResolvedValue(true);
    f.builder.getMany.mockResolvedValue([
      {
        id: 'expired',
        data: {
          profile: {
            provider: 'google',
            providerClientId: 'client',
            subject: 'subject',
            encryptedRevocationGrant: 'server-ciphertext',
          },
        },
      },
    ]);
    await f.service.processOnce();
    expect(f.revocations.enqueue).not.toHaveBeenCalled();
    expect(f.manager.delete).toHaveBeenCalled();
  });
});
