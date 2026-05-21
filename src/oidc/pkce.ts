import { createHash } from 'node:crypto';

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const digest = createHash('sha256').update(verifier).digest('base64url');
  return digest === challenge;
}
