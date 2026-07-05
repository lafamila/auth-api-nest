import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  randomUUID,
} from 'node:crypto';
import { Repository } from 'typeorm';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import { SigningKeyEntity } from '../database/entities/signing-key.entity';

export interface ActiveSigningKey {
  kid: string;
  privateKeyPem: string;
  publicJwk: Record<string, unknown>;
}

@Injectable()
export class SigningKeyService implements OnModuleInit {
  private readonly logger = new Logger(SigningKeyService.name);
  private activeKey?: ActiveSigningKey;
  private readonly publicKeysByKid = new Map<string, KeyObject>();
  private publicJwks: Record<string, unknown>[] = [];

  constructor(
    @InjectRepository(SigningKeyEntity)
    private readonly signingKeys: Repository<SigningKeyEntity>,
    private readonly aes: AesGcmService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadOrCreate();
  }

  getActiveKey(): ActiveSigningKey {
    if (!this.activeKey) {
      // Reached only when the DB-backed key has not been loaded yet (pre-init
      // or DB unavailable). Fall back to an ephemeral in-memory key so token
      // issuance never crashes; onModuleInit replaces it with the persisted key.
      const ephemeral = this.buildKeyPair();
      this.registerVerificationKey(ephemeral.kid, ephemeral.publicJwk);
      this.publicJwks = [...this.publicJwks, ephemeral.publicJwk];
      this.activeKey = ephemeral;
    }
    return this.activeKey;
  }

  jwks(): { keys: Record<string, unknown>[] } {
    // Expose the active key plus any retiring keys so consumers can still verify
    // access tokens signed by a previous key during its retention window.
    this.getActiveKey();
    return { keys: this.publicJwks };
  }

  /**
   * Resolve the public key that verifies a token with the given `kid`. Falls
   * back to the active key's public material when the header carries no kid or
   * an unknown one (which also lets a caller trigger a JWKS refetch upstream).
   */
  getVerificationKey(kid?: string): KeyObject {
    if (kid) {
      const match = this.publicKeysByKid.get(kid);
      if (match) {
        return match;
      }
    }
    const active = this.getActiveKey();
    const fallback = this.publicKeysByKid.get(active.kid);
    if (fallback) {
      return fallback;
    }
    return createPublicKey({ key: active.publicJwk as never, format: 'jwk' });
  }

  private async loadOrCreate(): Promise<void> {
    const rows = await this.signingKeys.find({ order: { createdAt: 'DESC' } });
    let active = rows.find((row) => row.active);
    if (!active) {
      active = await this.generateAndPersist();
      rows.unshift(active);
    }
    this.publicJwks = [];
    this.publicKeysByKid.clear();
    for (const row of rows) {
      this.registerVerificationKey(row.kid, row.publicKeyJwk);
      this.publicJwks.push(row.publicKeyJwk);
    }
    this.activeKey = {
      kid: active.kid,
      privateKeyPem: this.decodePrivateKey(active.privateKeyPem),
      publicJwk: active.publicKeyJwk,
    };
    this.logger.log(
      `Loaded signing key ${active.kid} (${rows.length} key(s) published in JWKS)`,
    );
  }

  private async generateAndPersist(): Promise<SigningKeyEntity> {
    const key = this.buildKeyPair();
    const entity = this.signingKeys.create({
      kid: key.kid,
      privateKeyPem: this.aes.encrypt(key.privateKeyPem),
      publicKeyJwk: key.publicJwk,
      active: true,
    });
    const saved = await this.signingKeys.save(entity);
    this.logger.log(`Generated and persisted new signing key ${key.kid}`);
    return saved;
  }

  private registerVerificationKey(
    kid: string,
    publicJwk: Record<string, unknown>,
  ): void {
    const jwk = {
      kty: publicJwk.kty,
      n: publicJwk.n,
      e: publicJwk.e,
    };
    this.publicKeysByKid.set(
      kid,
      createPublicKey({ key: jwk as never, format: 'jwk' }),
    );
  }

  private buildKeyPair(): ActiveSigningKey {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
    const kid = `local-${randomUUID()}`;
    return {
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
  }

  private decodePrivateKey(stored: string): string {
    // Keys created before at-rest encryption (or in a misconfigured env) would
    // be plain PEM; keep reading them so a stored key is never lost.
    if (stored.startsWith('-----BEGIN')) {
      return stored;
    }
    return this.aes.decrypt(stored);
  }
}
