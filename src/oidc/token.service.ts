import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { hashToken } from '../common/crypto/token-hash';
import { AccountEntity } from '../database/entities/account.entity';
import { OidcClientEntity } from '../database/entities/oidc-client.entity';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { AppConfigService } from '../config/app-config.service';
import { SigningKeyService } from './signing-key.service';

interface RefreshRecord {
  accountId: string;
  clientId: string;
  familyId: string;
  status: 'active' | 'used' | 'revoked';
  expiresAt: Date;
}

@Injectable()
export class TokenService {
  private readonly refreshTokens = new Map<string, RefreshRecord>();

  constructor(
    private readonly config: AppConfigService,
    private readonly signingKeys: SigningKeyService,
  ) {}

  issueTokens(
    account: AccountEntity,
    client: OidcClientEntity,
    permission: AccountServicePermissionEntity,
    familyId: string = randomUUID(),
  ) {
    const key = this.signingKeys.getActiveKey();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const serviceClaim = {
      key: client.service.serviceKey,
      permission: permission.permissionDefinition.key,
      permissionSchemaVersion: client.service.permissionSchemaVersion,
    };
    const idToken = jwt.sign(
      {
        iss: this.config.issuerUrl,
        sub: account.id,
        aud: client.clientId,
        iat: nowSeconds,
        auth_time: nowSeconds,
        email: account.email,
        name: account.name,
        preferred_username: account.loginId,
      },
      key.privateKeyPem,
      {
        algorithm: 'RS256',
        expiresIn: '15m',
        keyid: key.kid,
      },
    );
    const accessToken = jwt.sign(
      {
        iss: this.config.issuerUrl,
        sub: account.id,
        aud: `service:${client.service.serviceKey}`,
        scope: 'openid profile email service.permission',
        email: account.email,
        name: account.name,
        preferred_username: account.loginId,
        'https://lafamila.xyz/claims/service': serviceClaim,
      },
      key.privateKeyPem,
      {
        algorithm: 'RS256',
        expiresIn: '15m',
        keyid: key.kid,
      },
    );
    const refreshToken = randomBytes(48).toString('base64url');
    this.refreshTokens.set(hashToken(refreshToken), {
      accountId: account.id,
      clientId: client.clientId,
      familyId,
      status: 'active',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    return {
      token_type: 'Bearer',
      expires_in: 900,
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  consumeRefreshToken(refreshToken: string): RefreshRecord {
    const record = this.refreshTokens.get(hashToken(refreshToken));
    if (!record || record.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (record.status !== 'active') {
      this.revokeFamily(record.familyId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    record.status = 'used';
    return record;
  }

  revokeRefreshToken(refreshToken: string): void {
    const record = this.refreshTokens.get(hashToken(refreshToken));
    if (record) {
      record.status = 'revoked';
    }
  }

  revokeFamily(familyId: string): void {
    for (const record of this.refreshTokens.values()) {
      if (record.familyId === familyId) {
        record.status = 'revoked';
      }
    }
  }

  verifyAccessToken(token: string): Record<string, unknown> {
    const key = this.signingKeys.getActiveKey();
    return jwt.verify(token, key.privateKeyPem, {
      algorithms: ['RS256'],
      issuer: this.config.issuerUrl,
      ignoreExpiration: false,
    }) as Record<string, unknown>;
  }
}
