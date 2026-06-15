import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';

@Injectable()
export class AesGcmService {
  constructor(private readonly config: AppConfigService) {}

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext] = payload.split('.');
    if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext) {
      throw new Error('Invalid encrypted payload');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(encodedIv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  private key(): Buffer {
    const raw = this.config.adminOtpEncryptionKey;
    if (/^[A-Za-z0-9_-]{43,44}$/.test(raw)) {
      const decoded = Buffer.from(raw, 'base64url');
      if (decoded.length === 32) {
        return decoded;
      }
    }
    if (/^[A-Fa-f0-9]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    return createHash('sha256').update(raw).digest();
  }
}
