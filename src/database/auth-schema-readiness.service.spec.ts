import { DataSource } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';
import { AuthSchemaReadinessService } from './auth-schema-readiness.service';

describe('Auth schema and production configuration readiness', () => {
  const good = {
    nodeEnv: 'production',
    cookieSecret: '9a'.repeat(32),
    adminOtpEncryptionKey: '8b'.repeat(32),
    signupEmailCodePepper: '7c'.repeat(32),
  };
  it('does not allow a partial migration to look healthy', async () => {
    const source = {
      query: jest.fn().mockResolvedValue([{ policy_consents: false }]),
    };
    await expect(
      new AuthSchemaReadinessService(
        source as unknown as DataSource,
        good as AppConfigService,
      ).onModuleInit(),
    ).rejects.toThrow('Auth schema is not ready');
  });
  it.each([
    'cookieSecret',
    'adminOtpEncryptionKey',
    'signupEmailCodePepper',
  ] as const)(
    'rejects a sample %s without logging its value',
    async (field) => {
      const source = { query: jest.fn().mockResolvedValue([{ ready: true }]) };
      await expect(
        new AuthSchemaReadinessService(
          source as unknown as DataSource,
          {
            ...good,
            [field]: 'change-me-32-byte-minimum-admin-otp-encryption-key',
          } as AppConfigService,
        ).onModuleInit(),
      ).rejects.toThrow('must be a stable production secret');
      expect(source.query).not.toHaveBeenCalled();
    },
  );
  it('accepts a complete schema and configured production secrets', async () => {
    const source = { query: jest.fn().mockResolvedValue([{ ready: true }]) };
    await expect(
      new AuthSchemaReadinessService(
        source as unknown as DataSource,
        good as AppConfigService,
      ).onModuleInit(),
    ).resolves.toBeUndefined();
  });
});
