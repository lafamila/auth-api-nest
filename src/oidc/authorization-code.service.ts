import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager, MoreThan, Repository } from 'typeorm';
import { hashToken } from '../common/crypto/token-hash';
import { extractReturnedRow } from '../database/pg-returning';
import { AccountEntity } from '../database/entities/account.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import {
  authenticationMethod,
  AuthenticationMethod,
} from './authentication-method';

export interface AuthorizationCodeRecord {
  accountId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  nonce?: string;
  credentialVersion?: number;
  authenticationMethod?: AuthenticationMethod;
  expiresAt: Date;
}

export type AuthorizationCodeCreateInput = Omit<
  AuthorizationCodeRecord,
  'expiresAt' | 'credentialVersion'
> & {
  credentialVersion: number;
};

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
    private readonly dataSource: DataSource,
  ) {}

  async create(record: AuthorizationCodeCreateInput): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    await this.dataSource.transaction(async (manager) => {
      const account = await manager.getRepository(AccountEntity).findOne({
        where: { id: record.accountId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !account ||
        account.status !== 'active' ||
        account.passwordResetRequired ||
        (account.credentialVersion ?? 0) !== record.credentialVersion
      ) {
        throw new UnauthorizedException(
          'Account credentials changed before authorization code issuance',
        );
      }
      await manager.getRepository(TokenRecordEntity).insert({
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
          nonce: record.nonce,
          credentialVersion: record.credentialVersion,
          authenticationMethod: authenticationMethod(
            record.authenticationMethod,
          ),
        },
        usedAt: null,
        expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
      });
    });
    return code;
  }

  async findActive(code: string): Promise<AuthorizationCodeRecord | null> {
    const row = await this.tokenRecords.findOne({
      where: {
        tokenHash: hashToken(code),
        type: 'authorization_code',
        status: 'active',
        expiresAt: MoreThan(new Date()),
      },
    });
    return row ? this.toRecord(row) : null;
  }

  async consume(
    code: string,
    manager?: EntityManager,
  ): Promise<AuthorizationCodeRecord | null> {
    // Delete-on-consume keeps authorization codes strictly single-use and leaves
    // no rows behind; persisting in token_records survives a process restart.
    const repository = manager
      ? manager.getRepository(TokenRecordEntity)
      : this.tokenRecords;
    const result: unknown = await repository.query(
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
    return this.rowToRecord(row);
  }

  isCurrentCredential(
    code: AuthorizationCodeRecord,
    account: AccountEntity,
  ): boolean {
    const currentVersion = account.credentialVersion ?? 0;
    return code.credentialVersion === undefined
      ? currentVersion === 0
      : code.credentialVersion === currentVersion;
  }

  private toRecord(row: TokenRecordEntity): AuthorizationCodeRecord {
    return this.rowToRecord({
      account_id: row.accountId ?? '',
      client_id: row.clientId,
      metadata_json: row.metadataJson,
      expires_at: row.expiresAt,
    });
  }

  private rowToRecord(row: AuthorizationCodeRow): AuthorizationCodeRecord {
    const metadata = (row.metadata_json ?? {}) as {
      redirectUri?: string;
      codeChallenge?: string;
      scope?: string;
      nonce?: string;
      credentialVersion?: number;
      authenticationMethod?: string;
    };
    return {
      accountId: row.account_id,
      clientId: row.client_id,
      redirectUri: metadata.redirectUri ?? '',
      codeChallenge: metadata.codeChallenge ?? '',
      codeChallengeMethod: 'S256',
      scope: metadata.scope ?? '',
      nonce: metadata.nonce,
      credentialVersion: metadata.credentialVersion,
      authenticationMethod: authenticationMethod(metadata.authenticationMethod),
      expiresAt:
        row.expires_at instanceof Date
          ? row.expires_at
          : new Date(row.expires_at),
    };
  }
}
