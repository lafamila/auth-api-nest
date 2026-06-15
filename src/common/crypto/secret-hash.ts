import { createHash, timingSafeEqual } from 'node:crypto';

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function verifySecretHash(hash: string, value: string): boolean {
  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(hashSecret(value), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
