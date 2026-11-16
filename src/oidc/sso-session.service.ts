import { randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request, Response } from 'express';
import { DataSource, Repository } from 'typeorm';
import { hashToken } from '../common/crypto/token-hash';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';

const PRIMARY_COOKIE = 'tas_session';
const SESSION_COOKIE = 'tas_session_id';
const SESSION_CLIENT_ID = 'auth-sso';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type SessionRequest = Request & {
  signedCookies?: Record<string, string | false | undefined>;
  cookies?: Record<string, unknown>;
};

@Injectable()
export class SsoSessionService {
  constructor(
    @InjectRepository(AccountEntity)
    private readonly accounts: Repository<AccountEntity>,
    @InjectRepository(TokenRecordEntity)
    private readonly tokenRecords: Repository<TokenRecordEntity>,
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
  ) {}

  async create(account: AccountEntity, response: Response): Promise<void> {
    const authenticatedVersion =
      account.credentialVersion === undefined ? 0 : account.credentialVersion;
    if (!Number.isInteger(authenticatedVersion) || authenticatedVersion < 0) {
      throw new UnauthorizedException('Account session is no longer valid');
    }
    const rawToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    await this.dataSource.transaction(async (manager) => {
      const freshAccount = await manager.getRepository(AccountEntity).findOne({
        where: { id: account.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !freshAccount ||
        freshAccount.status !== 'active' ||
        freshAccount.passwordResetRequired ||
        freshAccount.credentialVersion !== authenticatedVersion
      ) {
        throw new UnauthorizedException('Account session is no longer valid');
      }

      await manager.getRepository(TokenRecordEntity).insert({
        tokenHash: hashToken(rawToken),
        type: 'sso_session',
        status: 'active',
        familyId: null,
        accountId: freshAccount.id,
        clientId: SESSION_CLIENT_ID,
        serviceId: null,
        metadataJson: { credentialVersion: authenticatedVersion },
        usedAt: null,
        expiresAt,
      });
    });

    response.cookie(PRIMARY_COOKIE, account.id, this.cookieOptions());
    response.cookie(SESSION_COOKIE, rawToken, this.cookieOptions());
  }

  async accountId(request: Request): Promise<string | null> {
    const sessionRequest = request as SessionRequest;
    const primaryAccountId = this.validSignedCookie(
      sessionRequest,
      PRIMARY_COOKIE,
    );
    if (!primaryAccountId) {
      return null;
    }

    const signedSessionId = sessionRequest.signedCookies?.[SESSION_COOKIE];
    const rawSessionPresent = this.hasRawCookie(sessionRequest, SESSION_COOKIE);
    const sessionCookiePresent =
      signedSessionId !== undefined || rawSessionPresent;

    if (!sessionCookiePresent) {
      const account = await this.accounts.findOneBy({ id: primaryAccountId });
      return this.isCurrentAccount(account, 0) ? primaryAccountId : null;
    }

    if (
      typeof signedSessionId !== 'string' ||
      !OPAQUE_TOKEN_PATTERN.test(signedSessionId) ||
      rawSessionPresent
    ) {
      return null;
    }

    const session = await this.tokenRecords.findOne({
      where: { tokenHash: hashToken(signedSessionId) },
    });
    const credentialVersion = this.sessionCredentialVersion(session);
    if (
      !session ||
      session.type !== 'sso_session' ||
      session.clientId !== SESSION_CLIENT_ID ||
      session.status !== 'active' ||
      session.accountId !== primaryAccountId ||
      !(session.expiresAt instanceof Date) ||
      !Number.isFinite(session.expiresAt.getTime()) ||
      session.expiresAt.getTime() <= Date.now() ||
      credentialVersion === null
    ) {
      return null;
    }

    const account = await this.accounts.findOneBy({ id: primaryAccountId });
    return this.isCurrentAccount(account, credentialVersion)
      ? primaryAccountId
      : null;
  }

  async clear(request: Request, response: Response): Promise<void> {
    const sessionRequest = request as SessionRequest;
    const signedSessionId = this.validSignedCookie(
      sessionRequest,
      SESSION_COOKIE,
    );

    if (signedSessionId && OPAQUE_TOKEN_PATTERN.test(signedSessionId)) {
      await this.tokenRecords.update(
        {
          tokenHash: hashToken(signedSessionId),
          type: 'sso_session',
          clientId: SESSION_CLIENT_ID,
          status: 'active',
        },
        { status: 'revoked', usedAt: new Date() },
      );
    }

    response.clearCookie(PRIMARY_COOKIE, this.clearCookieOptions());
    response.clearCookie(SESSION_COOKIE, this.clearCookieOptions());
  }

  private sessionCredentialVersion(
    session: TokenRecordEntity | null,
  ): number | null {
    const value = session?.metadataJson?.credentialVersion;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? value
      : null;
  }

  private isCurrentAccount(
    account: AccountEntity | null,
    credentialVersion: number,
  ): boolean {
    return Boolean(
      account &&
      account.status === 'active' &&
      !account.passwordResetRequired &&
      account.credentialVersion === credentialVersion,
    );
  }

  private validSignedCookie(
    request: SessionRequest,
    name: string,
  ): string | null {
    const value = request.signedCookies?.[name];
    return typeof value === 'string' &&
      value.length > 0 &&
      !this.hasRawCookie(request, name)
      ? value
      : null;
  }

  private hasRawCookie(request: SessionRequest, name: string): boolean {
    return Boolean(
      request.cookies &&
      Object.prototype.hasOwnProperty.call(request.cookies, name),
    );
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.nodeEnv === 'production',
      sameSite: 'lax' as const,
      signed: true,
      maxAge: SESSION_DURATION_MS,
      path: '/',
    };
  }

  private clearCookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.nodeEnv === 'production',
      sameSite: 'lax' as const,
      path: '/',
    };
  }
}
