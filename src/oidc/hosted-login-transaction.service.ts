import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { hashToken } from '../common/crypto/token-hash';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { extractReturnedRow } from '../database/pg-returning';
import { AuthorizeRequestInput } from './authorize-flow.service';

const HOSTED_LOGIN_TRANSACTION_TTL_MS = 5 * 60 * 1000;
const HOSTED_LOGIN_COOKIE_PREFIX = 'tas_authorize_transaction_';

interface HostedLoginTransactionRow {
  account_id: string | null;
  client_id: string;
  metadata_json: Record<string, unknown> | null;
  expires_at: Date | string;
}

export interface HostedLoginTransaction {
  request: AuthorizeRequestInput;
  sessionAccountId: string | null;
  expiresAt: Date;
}

@Injectable()
export class HostedLoginTransactionService {
  constructor(
    @InjectRepository(TokenRecordEntity)
    private readonly tokenRecords: Repository<TokenRecordEntity>,
  ) {}

  async create(input: {
    request: AuthorizeRequestInput;
    sessionAccountId: string | null;
  }): Promise<{ id: string; browserNonce: string }> {
    const id = randomBytes(32).toString('base64url');
    const browserNonce = randomBytes(32).toString('base64url');
    await this.tokenRecords.insert({
      tokenHash: hashToken(id),
      type: 'authorization_login',
      status: 'active',
      accountId: input.sessionAccountId,
      clientId: input.request.clientId,
      familyId: null,
      serviceId: null,
      metadataJson: {
        authorizeRequest: input.request,
        browserBindingHash: hashToken(browserNonce),
      },
      usedAt: null,
      expiresAt: new Date(Date.now() + HOSTED_LOGIN_TRANSACTION_TTL_MS),
    });
    return { id, browserNonce };
  }

  async consume(
    id: string,
    browserNonce: string,
  ): Promise<HostedLoginTransaction | null> {
    const result: unknown = await this.tokenRecords.query(
      `
        DELETE FROM token_records
        WHERE token_hash = $1
          AND type = 'authorization_login'
          AND status = 'active'
          AND expires_at > now()
          AND metadata_json->>'browserBindingHash' = $2
        RETURNING account_id, client_id, metadata_json, expires_at
      `,
      [hashToken(id), hashToken(browserNonce)],
    );
    const row = extractReturnedRow<HostedLoginTransactionRow>(result);
    if (!row) {
      return null;
    }
    return this.rowToTransaction(row);
  }

  async find(
    id: string,
    browserNonce: string,
  ): Promise<HostedLoginTransaction | null> {
    const result: unknown = await this.tokenRecords.query(
      `
        SELECT account_id, client_id, metadata_json, expires_at
        FROM token_records
        WHERE token_hash = $1
          AND type = 'authorization_login'
          AND status = 'active'
          AND expires_at > now()
          AND metadata_json->>'browserBindingHash' = $2
      `,
      [hashToken(id), hashToken(browserNonce)],
    );
    const row = extractReturnedRow<HostedLoginTransactionRow>(result);
    return row ? this.rowToTransaction(row) : null;
  }

  cookieName(id: string): string {
    return `${HOSTED_LOGIN_COOKIE_PREFIX}${hashToken(id).slice(0, 24)}`;
  }

  private readAuthorizeRequest(
    metadata: Record<string, unknown> | null,
  ): AuthorizeRequestInput | null {
    const value = metadata?.authorizeRequest;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const request = value as Record<string, unknown>;
    const requiredKeys = [
      'clientId',
      'redirectUri',
      'responseType',
      'scope',
      'codeChallenge',
      'codeChallengeMethod',
    ] as const;
    if (requiredKeys.some((key) => typeof request[key] !== 'string')) {
      return null;
    }
    if (request.state !== undefined && typeof request.state !== 'string') {
      return null;
    }
    if (request.nonce !== undefined && typeof request.nonce !== 'string') {
      return null;
    }
    if (request.prompt !== undefined && typeof request.prompt !== 'string') {
      return null;
    }
    return {
      clientId: request.clientId as string,
      redirectUri: request.redirectUri as string,
      responseType: request.responseType as string,
      scope: request.scope as string,
      state: request.state,
      nonce: request.nonce,
      codeChallenge: request.codeChallenge as string,
      codeChallengeMethod: request.codeChallengeMethod as string,
      prompt: request.prompt,
    };
  }

  private rowToTransaction(
    row: HostedLoginTransactionRow,
  ): HostedLoginTransaction | null {
    const request = this.readAuthorizeRequest(row.metadata_json);
    if (!request || request.clientId !== row.client_id) {
      return null;
    }
    return {
      request,
      sessionAccountId: row.account_id,
      expiresAt:
        row.expires_at instanceof Date
          ? row.expires_at
          : new Date(row.expires_at),
    };
  }
}
