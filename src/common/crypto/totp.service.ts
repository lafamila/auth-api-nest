import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

@Injectable()
export class TotpService {
  constructor(private readonly config: AppConfigService) {}

  generateSecret(): string {
    let bits = '';
    for (const byte of randomBytes(20)) {
      bits += byte.toString(2).padStart(8, '0');
    }
    let output = '';
    for (let index = 0; index < bits.length; index += 5) {
      const chunk = bits.slice(index, index + 5).padEnd(5, '0');
      output += BASE32_ALPHABET[parseInt(chunk, 2)];
    }
    return output;
  }

  otpauthUri(input: { secret: string; loginId: string; issuer?: string }): string {
    const issuer = input.issuer ?? 'Teddy Auth Admin';
    const label = `${issuer}:${input.loginId}`;
    const params = new URLSearchParams({
      secret: input.secret,
      issuer,
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
    return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
  }

  verify(secret: string, code: string, now = Date.now()): boolean {
    const normalized = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalized)) {
      return false;
    }
    const expectedCodes = [-1, 0, 1].map((window) =>
      this.generateCode(secret, now + window * 30_000),
    );
    return expectedCodes.some((expected) => this.safeEqual(expected, normalized));
  }

  private generateCode(secret: string, now: number): string {
    const counter = Math.floor(now / 30_000);
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buffer.writeUInt32BE(counter & 0xffffffff, 4);
    const hmac = createHmac('sha1', this.decodeBase32(secret)).update(buffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const value =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    return String(value % 1_000_000).padStart(6, '0');
  }

  private decodeBase32(value: string): Buffer {
    let bits = '';
    for (const char of value.replace(/=+$/g, '').toUpperCase()) {
      const index = BASE32_ALPHABET.indexOf(char);
      if (index < 0) {
        throw new Error('Invalid base32 secret');
      }
      bits += index.toString(2).padStart(5, '0');
    }
    const bytes: number[] = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) {
      bytes.push(parseInt(bits.slice(index, index + 8), 2));
    }
    return Buffer.from(bytes);
  }

  private safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }
}
