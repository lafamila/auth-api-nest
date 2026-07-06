import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { hashToken } from '../common/crypto/token-hash';
import { extractReturnedRow } from '../database/pg-returning';
import { TokenRecordEntity } from '../database/entities/token-record.entity';

export interface AuthorizationCodeRecord {
  accountId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  expiresAt: Date;
}

interface AuthorizationCodeRow {
  account_id: string;
  client_id: string;
  metadata_json: Record<string, unknown> | null;
  expires_at: Date | string;
}

const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;

@Injectable()
export class AuthorizationCodeService {
  constructor(
    @InjectRepository(TokenRecordEntity)
    private readonly tokenRecords: Repository<TokenRecordEntity>,
  ) {}

  async create(
    record: Omit<AuthorizationCodeRecord, 'expiresAt'>,
  ): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    await this.tokenRecords.insert({
      tokenHash: hashToken(code),
      type: 'authorization_code',
      status: 'active',
      accountId: record.accountId,
      clientId: record.clientId,
      familyId: null,
      serviceId: null,
      metadataJson: {
        redirectUri: record.redirectUri,
        codeChallenge: record.codeChallenge,
        codeChallengeMethod: record.codeChallengeMethod,
        scope: record.scope,
      },
      usedAt: null,
      expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
    });
    return code;
  }

  async consume(code: string): Promise<AuthorizationCodeRecord | null> {
    // Delete-on-consume keeps authorization codes strictly single-use and leaves
    // no rows behind; persisting in token_records survives a process restart.
    const result: unknown = await this.tokenRecords.query(
      `
        DELETE FROM token_records
        WHERE token_hash = $1
          AND type = 'authorization_code'
          AND status = 'active'
          AND expires_at > now()
        RETURNING account_id, client_id, metadata_json, expires_at
      `,
      [hashToken(code)],
    );
    const row = extractReturnedRow<AuthorizationCodeRow>(result);
    if (!row) {
      return null;
    }
    const metadata = (row.metadata_json ?? {}) as {
      redirectUri?: string;
      codeChallenge?: string;
      scope?: string;
    };
    return {
      accountId: row.account_id,
      clientId: row.client_id,
      redirectUri: metadata.redirectUri ?? '',
      codeChallenge: metadata.codeChallenge ?? '',
      codeChallengeMethod: 'S256',
      scope: metadata.scope ?? '',
      expiresAt:
        row.expires_at instanceof Date
          ? row.expires_at
          : new Date(row.expires_at),
    };
  }
}
