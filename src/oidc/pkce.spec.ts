import { createHash } from 'node:crypto';
import { verifyPkceS256 } from './pkce';

describe('verifyPkceS256', () => {
  it('matches a verifier to its S256 challenge', () => {
    const verifier = 'correct-horse-battery-staple-verifier';
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256('wrong-verifier', challenge)).toBe(false);
  });
});
