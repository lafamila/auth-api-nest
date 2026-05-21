import { Injectable } from '@nestjs/common';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

export interface ActiveSigningKey {
  kid: string;
  privateKeyPem: string;
  publicJwk: Record<string, unknown>;
}

@Injectable()
export class SigningKeyService {
  private activeKey?: ActiveSigningKey;

  getActiveKey(): ActiveSigningKey {
    if (!this.activeKey) {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });
      const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
      const kid = `local-${randomUUID()}`;
      const activeKey: ActiveSigningKey = {
        kid,
        privateKeyPem: privateKey.export({
          format: 'pem',
          type: 'pkcs8',
        }) as string,
        publicJwk: {
          ...publicJwk,
          kid,
          use: 'sig',
          alg: 'RS256',
        },
      };
      this.activeKey = activeKey;
    }
    return this.activeKey;
  }

  jwks(): { keys: Record<string, unknown>[] } {
    return { keys: [this.getActiveKey().publicJwk] };
  }
}
