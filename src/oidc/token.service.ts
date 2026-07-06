import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { extractReturnedRow } from '../database/pg-returning';
import { hashToken } from '../common/crypto/token-hash';
import { AccountEntity } from '../database/entities/account.entity';
import { OidcClientEntity } from '../database/entities/oidc-client.entity';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { AppConfigService } from '../config/app-config.service';
import { SigningKeyService } from './signing-key.service';
import { Repository } from 'typeorm';

interface RefreshRecord {
  accountId: string;
  clientId: string;
  familyId: string;
  status: 'active' | 'used' | 'revoked';
  expiresAt: Date;
}

const CLEANUP_THROTTLE_MS = 10 * 60 * 1000;

@Injectable()
export class TokenService implements OnModuleInit {
  private readonly logger = new Logger(TokenService.name);
  private lastCleanupAt = 0;

  constructor(
    private readonly config: AppConfigService,
    private readonly signingKeys: SigningKeyService,
    @InjectRepository(TokenRecordEntity)
    private readonly tokenRecords: Repository<TokenRecordEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.cleanupExpiredTokens();
  }

  async issueTokens(
    account: AccountEntity,
    client: OidcClientEntity,
    permission: AccountServicePermissionEntity,
    familyId: string = randomUUID(),
  ) {
    const key = this.signingKeys.getActiveKey();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const accessTtlSeconds =
      client.accessTokenTtlSeconds ?? this.config.accessTokenTtlSeconds;
    const refreshTtlSeconds =
      client.refreshTokenTtlSeconds ?? this.config.refreshTokenTtlSeconds;
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
        expiresIn: accessTtlSeconds,
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
        expiresIn: accessTtlSeconds,
        keyid: key.kid,
      },
    );
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + refreshTtlSeconds * 1000);
    await this.tokenRecords.insert({
      tokenHash: hashToken(refreshToken),
      type: 'refresh_token',
      status: 'active',
      accountId: account.id,
      clientId: client.clientId,
      familyId,
      serviceId: client.service?.id ?? client.serviceId ?? null,
      metadataJson: null,
      expiresAt,
    });
    return {
      token_type: 'Bearer',
      expires_in: accessTtlSeconds,
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  async consumeRefreshToken(refreshToken: string): Promise<RefreshRecord> {
    this.maybeCleanupExpiredTokens();
    const tokenHash = hashToken(refreshToken);
    const consumeResult: unknown = await this.tokenRecords.query(
      `
        UPDATE token_records
        SET status = 'used', used_at = now()
        WHERE token_hash = $1
          AND type = 'refresh_token'
          AND status = 'active'
          AND expires_at > now()
        RETURNING account_id, client_id, family_id, status, expires_at
      `,
      [tokenHash],
    );
    const consumed = extractReturnedRow<RefreshTokenRow>(consumeResult);
    if (consumed) {
      return refreshRowToRecord(consumed);
    }

    const record = await this.tokenRecords.findOne({
      where: { tokenHash, type: 'refresh_token' },
    });
    if (!record || record.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (record.status === 'used' && this.isWithinRotationGrace(record.usedAt)) {
      // A duplicate/retried rotation inside the grace window (e.g. the caller
      // crashed before persisting the previous rotation response). Allow one
      // more rotation instead of revoking the whole family. The identical
      // successor cannot be re-returned because only token hashes are stored.
      return {
        accountId: record.accountId,
        clientId: record.clientId,
        familyId: record.familyId ?? '',
        status: record.status,
        expiresAt: record.expiresAt,
      };
    }
    if (record.status !== 'active') {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    throw new UnauthorizedException('Invalid refresh token');
  }

  /**
   * Best-effort removal of long-expired token records (abandoned authorization
   * codes and expired refresh tokens). Runs at startup and, throttled, during
   * refresh so a long-running process still trims storage without a scheduler.
   */
  async cleanupExpiredTokens(): Promise<void> {
    this.lastCleanupAt = Date.now();
    try {
      await this.tokenRecords.query(
        `DELETE FROM token_records WHERE expires_at < now() - interval '1 hour'`,
        [],
      );
    } catch (error) {
      this.logger.warn(
        `token_records cleanup skipped: ${(error as Error).message}`,
      );
    }
  }

  private maybeCleanupExpiredTokens(): void {
    if (Date.now() - this.lastCleanupAt < CLEANUP_THROTTLE_MS) {
      return;
    }
    void this.cleanupExpiredTokens();
  }

  private isWithinRotationGrace(usedAt: Date | null): boolean {
    if (!usedAt) {
      return false;
    }
    const graceSeconds = this.config.refreshRotationGraceSeconds;
    if (!Number.isFinite(graceSeconds) || graceSeconds <= 0) {
      return false;
    }
    return Date.now() - usedAt.getTime() <= graceSeconds * 1000;
  }

  async getRefreshTokenAccountId(
    refreshToken: string,
  ): Promise<{ accountId: string; clientId: string } | null> {
    const record = await this.tokenRecords.findOne({
      where: { tokenHash: hashToken(refreshToken), type: 'refresh_token' },
    });
    if (!record) {
      return null;
    }
    return { accountId: record.accountId, clientId: record.clientId };
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    await this.tokenRecords.update(
      { tokenHash: hashToken(refreshToken), type: 'refresh_token' },
      { status: 'revoked' },
    );
  }

  async revokeFamily(familyId: string | null): Promise<void> {
    if (!familyId) {
      return;
    }
    await this.tokenRecords.update(
      { familyId, type: 'refresh_token' },
      { status: 'revoked' },
    );
  }

  verifyAccessToken(token: string): Record<string, unknown> {
    const decoded = jwt.decode(token, { complete: true });
    const kid =
      decoded && typeof decoded === 'object'
        ? (decoded.header?.kid as string | undefined)
        : undefined;
    const key = this.signingKeys.getVerificationKey(kid);
    return jwt.verify(token, key, {
      algorithms: ['RS256'],
      issuer: this.config.issuerUrl,
      ignoreExpiration: false,
    }) as Record<string, unknown>;
  }
}

interface RefreshTokenRow {
  account_id: string;
  client_id: string;
  family_id: string | null;
  status: RefreshRecord['status'];
  expires_at: Date | string;
}

function refreshRowToRecord(row: RefreshTokenRow): RefreshRecord {
  return {
    accountId: row.account_id,
    clientId: row.client_id,
    familyId: row.family_id ?? '',
    status: row.status,
    expiresAt:
      row.expires_at instanceof Date
        ? row.expires_at
        : new Date(row.expires_at),
  };
}
