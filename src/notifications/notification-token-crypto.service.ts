import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';

@Injectable()
export class NotificationTokenCryptoService implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    if (
      this.config.nodeEnv === 'production' ||
      this.config.notificationsEnabled
    ) {
      this.key();
    }
  }

  encrypt(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext] =
      payload.split('.');
    if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext) {
      throw new Error('Invalid encrypted notification token');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(encodedIv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  fingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private key(): Buffer {
    const raw = this.config.notificationTokenEncryptionKey.trim();
    if (/^[A-Za-z0-9_-]{43,44}$/.test(raw)) {
      const decoded = Buffer.from(raw, 'base64url');
      if (decoded.length === 32) {
        return decoded;
      }
    }
    if (/^[A-Fa-f0-9]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    throw new Error(
      'NOTIFICATION_TOKEN_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64url or 64 hex characters',
    );
  }
}
