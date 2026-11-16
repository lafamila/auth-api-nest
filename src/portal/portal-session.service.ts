import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AdminAuthService } from '../admin/admin-auth.service';
import { hashToken } from '../common/crypto/token-hash';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { AdminSessionEntity } from '../database/entities/admin-session.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import {
  PORTAL_CLIENT_ID,
  PORTAL_COOKIE,
  PortalActor,
  RECENT_AUTH_MS,
} from './portal.types';

const SESSION_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class PortalSessionService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(TokenRecordEntity)
    private readonly tokens: Repository<TokenRecordEntity>,
    private readonly admin: AdminAuthService,
    private readonly config: AppConfigService,
  ) {}

  fingerprint(request: Request): string | null {
    const value = (
      request.signedCookies as Record<string, unknown> | undefined
    )?.[PORTAL_COOKIE];
    return typeof value === 'string' && value.length <= 128
      ? hashToken(value)
      : null;
  }

  async read(request: Request): Promise<PortalActor | null> {
    const tokenHash = this.fingerprint(request);
    if (!tokenHash) return null;
    const session = await this.tokens.findOneBy({
      tokenHash,
      type: 'portal_session',
      status: 'active',
    });
    if (!session?.accountId || session.expiresAt.getTime() <= Date.now())
      return null;
    const account = await this.dataSource
      .getRepository(AccountEntity)
      .findOneBy({ id: session.accountId });
    if (
      !account ||
      account.status !== 'active' ||
      account.passwordResetRequired ||
      (account.credentialVersion ?? 0) !==
        session.metadataJson?.credentialVersion
    )
      return null;
    if (account.isSuperAdmin) {
      try {
        const admin = await this.admin.validateRequest(request);
        const adminSession = (
          request as Request & { adminSession?: AdminSessionEntity }
        ).adminSession;
        if (
          admin.id !== account.id ||
          adminSession?.id !== session.metadataJson?.adminSessionId
        )
          return null;
      } catch (error) {
        if (
          error instanceof UnauthorizedException ||
          error instanceof ForbiddenException
        )
          return null;
        throw error;
      }
    }
    return { account, session, csrfToken: this.csrf(session) };
  }

  async require(request: Request, mutation = false): Promise<PortalActor> {
    const origin = request.header('origin');
    if (origin && origin !== new URL(this.config.issuerUrl).origin)
      throw new ForbiddenException('Cross-origin portal access is not allowed');
    const actor = await this.read(request);
    if (!actor) throw new UnauthorizedException('Login is required');
    if (mutation) {
      const supplied = request.header('x-csrf-token');
      if (
        !supplied ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(actor.csrfToken) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(actor.csrfToken))
      )
        throw new ForbiddenException('Invalid CSRF token');
    }
    return actor;
  }

  requireRecent(actor: PortalActor) {
    const raw = actor.session.metadataJson?.authenticatedAt;
    const authenticatedAt = typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (
      !Number.isFinite(authenticatedAt) ||
      Date.now() - authenticatedAt > RECENT_AUTH_MS
    )
      throw new ForbiddenException({
        code: 'reauthentication_required',
        message: '다시 인증이 필요합니다',
      });
  }

  async create(
    account: AccountEntity,
    response: Response,
    options: {
      method: string;
      authenticatedAt?: Date;
      adminSessionId?: string;
    },
  ): Promise<TokenRecordEntity> {
    const raw = randomBytes(32).toString('base64url');
    const session = await this.dataSource.transaction(async (manager) => {
      const current = await manager.findOneOrFail(AccountEntity, {
        where: { id: account.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        current.status !== 'active' ||
        current.passwordResetRequired ||
        (current.credentialVersion ?? 0) !== (account.credentialVersion ?? 0)
      )
        throw new UnauthorizedException('Account changed during login');
      if (current.isSuperAdmin) {
        if (!options.adminSessionId)
          throw new UnauthorizedException('Admin OTP is required');
        const adminSession = await manager.findOneBy(AdminSessionEntity, {
          id: options.adminSessionId,
          accountId: current.id,
          revokedAt: IsNull(),
        });
        if (
          !adminSession ||
          adminSession.idleExpiresAt.getTime() <= Date.now() ||
          adminSession.absoluteExpiresAt.getTime() <= Date.now() ||
          (adminSession.credentialVersion ?? 0) !== current.credentialVersion
        )
          throw new UnauthorizedException('Admin OTP session is invalid');
      }
      return manager.save(
        manager.create(TokenRecordEntity, {
          tokenHash: hashToken(raw),
          type: 'portal_session',
          status: 'active',
          accountId: current.id,
          clientId: PORTAL_CLIENT_ID,
          familyId: null,
          serviceId: null,
          usedAt: null,
          expiresAt: new Date(Date.now() + SESSION_MS),
          metadataJson: {
            credentialVersion: current.credentialVersion ?? 0,
            authenticatedAt: (
              options.authenticatedAt ?? new Date()
            ).toISOString(),
            method: options.method,
            ...(options.adminSessionId
              ? { adminSessionId: options.adminSessionId }
              : {}),
          },
        }),
      );
    });
    response.cookie(PORTAL_COOKIE, raw, {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: this.config.nodeEnv === 'production',
      path: '/',
      maxAge: SESSION_MS,
    });
    return session;
  }

  async clear(request: Request, response: Response) {
    const hash = this.fingerprint(request);
    if (hash)
      await this.tokens.update(
        { tokenHash: hash, type: 'portal_session', status: 'active' },
        { status: 'revoked' },
      );
    response.clearCookie(PORTAL_COOKIE, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.nodeEnv === 'production',
    });
  }

  private csrf(session: TokenRecordEntity) {
    return createHmac('sha256', this.config.cookieSecret)
      .update(`portal-csrf:${session.tokenHash}`)
      .digest('base64url');
  }
}
