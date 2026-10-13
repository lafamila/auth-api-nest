import { AppConfigService } from '../config/app-config.service';
import { NotificationTokenCryptoService } from './notification-token-crypto.service';

describe('NotificationTokenCryptoService', () => {
  const key = Buffer.alloc(32, 7).toString('base64url');

  function service(encryptionKey = key) {
    return new NotificationTokenCryptoService({
      notificationTokenEncryptionKey: encryptionKey,
      nodeEnv: 'test',
      notificationsEnabled: false,
    } as AppConfigService);
  }

  it('encrypts tokens with authenticated encryption and decrypts them', () => {
    const crypto = service();
    const encrypted = crypto.encrypt('fcm-device-token');

    expect(encrypted).not.toContain('fcm-device-token');
    expect(crypto.decrypt(encrypted)).toBe('fcm-device-token');
    expect(crypto.fingerprint('fcm-device-token')).toHaveLength(64);
    expect(crypto.fingerprint('fcm-device-token')).toBe(
      crypto.fingerprint('fcm-device-token'),
    );
  });

  it('rejects tampered ciphertext and invalid encryption keys', () => {
    const crypto = service();
    const encrypted = crypto.encrypt('fcm-device-token');
    const parts = encrypted.split('.');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    ciphertext[0] ^= 1;
    parts[3] = ciphertext.toString('base64url');
    const tampered = parts.join('.');

    expect(() => crypto.decrypt(tampered)).toThrow();
    expect(() => service('short').encrypt('token')).toThrow(
      'NOTIFICATION_TOKEN_ENCRYPTION_KEY',
    );
  });
});
