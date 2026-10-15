import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';

describe('AppConfigService Firebase private key', () => {
  it('normalizes Docker env-file quotes and literal newlines', () => {
    const config = {
      get: jest.fn((key: string, fallback: string) =>
        key === 'FIREBASE_PRIVATE_KEY'
          ? '"-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----\\n"'
          : fallback,
      ),
    } as unknown as ConfigService;

    expect(new AppConfigService(config).firebasePrivateKey).toBe(
      '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n',
    );
  });
});
