import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { AdminAuthService } from '../admin/admin-auth.service';
import { AdminMfaThrottleService } from '../admin/admin-mfa-throttle.service';
import { hashToken } from '../common/crypto/token-hash';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { AdminSessionEntity } from '../database/entities/admin-session.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { SsoSessionService } from '../oidc/sso-session.service';
import { PortalSessionService } from './portal-session.service';
import { PORTAL_CLIENT_ID } from './portal.types';

const MFA_MS = 5 * 60 * 1000;

@Injectable()
export class PortalAuthService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(TokenRecordEntity)
    private readonly tokens: Repository<TokenRecordEntity>,
    private readonly sessions: PortalSessionService,
    private readonly admin: AdminAuthService,
    private readonly mfaThrottle: AdminMfaThrottleService,
    private readonly sso: SsoSessionService,
    private readonly config: AppConfigService,
  ) {}

  async completePrimary(
    account: AccountEntity,
    request: Request,
    response: Response,
    expectedAccountId?: string,
    method = 'local',
  ) {
    if (expectedAccountId && expectedAccountId !== account.id)
      throw new UnauthorizedException('같은 계정으로 다시 인증해 주세요');
    if (account.status !== 'active' || account.passwordResetRequired)
      throw new UnauthorizedException('Account is unavailable');
    await this.sessions.clear(request, response);
    await this.admin.logout(request, response);
    if (account.isSuperAdmin) {
      const throttle = await this.mfaThrottle.consumeChallengeCreation(
        account.id,
        request,
      );
      if (!throttle.allowed) {
        await this.mfaThrottle.auditBlocked(account.id, request, throttle);
        throw new UnauthorizedException('OTP 인증 시도가 제한되었습니다');
      }
      const raw = randomBytes(32).toString('base64url');
      const binding = randomBytes(32).toString('base64url');
      await this.tokens.insert({
        tokenHash: hashToken(raw),
        type: 'portal_mfa',
        status: 'active',
        accountId: account.id,
        clientId: PORTAL_CLIENT_ID,
        familyId: null,
        serviceId: null,
        usedAt: null,
        expiresAt: new Date(Date.now() + MFA_MS),
        metadataJson: {
          browserBindingHash: hashToken(binding),
          credentialVersion: account.credentialVersion ?? 0,
          attempts: 0,
          method,
          afterLogin: expectedAccountId ? '/profile' : '/',
        },
      });
      response.cookie(this.cookieName(raw), binding, {
        httpOnly: true,
        signed: true,
        sameSite: 'strict',
        secure: this.config.nodeEnv === 'production',
        path: '/login/otp',
        maxAge: MFA_MS,
      });
      return `/login/otp?transaction=${encodeURIComponent(raw)}`;
    }
    await this.sessions.create(account, response, { method });
    await this.sso.create(account, response);
    return expectedAccountId ? '/profile' : '/';
  }

  async mfaPage(transaction: string, request: Request) {
    return this.dataSource.transaction(async (manager) => {
      const challenge = await this.loadChallenge(manager, transaction, request);
      const account = await manager.findOneByOrFail(AccountEntity, {
        id: challenge.accountId!,
      });
      if (
        account.status !== 'active' ||
        !account.isSuperAdmin ||
        account.passwordResetRequired ||
        (account.credentialVersion ?? 0) !==
          challenge.metadataJson?.credentialVersion
      )
        throw new BadRequestException('OTP challenge is no longer valid');
      return { transaction, name: account.name };
    });
  }

  async verifyOtp(
    transaction: string,
    code: string,
    request: Request,
    response: Response,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      const initial = await this.loadChallenge(
        manager,
        transaction,
        request,
        false,
      );
      const account = await manager.findOneOrFail(AccountEntity, {
        where: { id: initial.accountId! },
        lock: { mode: 'pessimistic_write' },
      });
      const challenge = await this.loadChallenge(manager, transaction, request);
      if (
        account.status !== 'active' ||
        !account.isSuperAdmin ||
        account.passwordResetRequired ||
        (account.credentialVersion ?? 0) !==
          challenge.metadataJson?.credentialVersion
      )
        throw new BadRequestException('OTP challenge is no longer valid');
      const throttle = await this.mfaThrottle.checkGuessAllowed(
        account.id,
        request,
        manager,
      );
      if (!throttle.allowed) {
        return { status: 'blocked' as const, accountId: account.id, throttle };
      }
      const attempts = Number(challenge.metadataJson?.attempts ?? 0);
      if (attempts >= 5) return { status: 'invalid' as const };
      if (!(await this.admin.verifyAccountOtp(account, code))) {
        challenge.metadataJson = {
          ...challenge.metadataJson,
          attempts: attempts + 1,
        };
        await manager.save(challenge);
        await this.mfaThrottle.recordFailure(account.id, request, manager);
        return { status: 'invalid' as const };
      }
      await manager.delete(TokenRecordEntity, challenge.id);
      return {
        status: 'success' as const,
        account,
        method:
          typeof challenge.metadataJson?.method === 'string'
            ? challenge.metadataJson.method
            : 'local',
        afterLogin:
          challenge.metadataJson?.afterLogin === '/profile' ? '/profile' : '/',
      };
    });
    if (result.status === 'blocked') {
      await this.mfaThrottle.auditBlocked(
        result.accountId,
        request,
        result.throttle,
      );
    }
    if (result.status !== 'success')
      throw new UnauthorizedException(
        'OTP 코드가 올바르지 않거나 시도 횟수를 초과했습니다',
      );
    await this.admin.issueVerifiedSession(result.account, request, response);
    const adminSession = (
      request as Request & { adminSession?: AdminSessionEntity }
    ).adminSession;
    await this.sessions.create(result.account, response, {
      method: result.method,
      adminSessionId: adminSession?.id,
    });
    await this.sso.create(result.account, response);
    response.clearCookie(this.cookieName(transaction), {
      path: '/login/otp',
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.nodeEnv === 'production',
    });
    return result.afterLogin;
  }

  cookieName(transaction: string) {
    return `tas_portal_mfa_${hashToken(transaction).slice(0, 24)}`;
  }

  private async loadChallenge(
    manager: import('typeorm').EntityManager,
    transaction: string,
    request: Request,
    lock = true,
  ) {
    if (
      typeof transaction !== 'string' ||
      !transaction ||
      transaction.length > 128
    )
      throw new BadRequestException('Invalid OTP challenge');
    const binding = (
      request.signedCookies as Record<string, unknown> | undefined
    )?.[this.cookieName(transaction)];
    if (typeof binding !== 'string' || !binding || binding.length > 128)
      throw new BadRequestException('Invalid OTP challenge');
    const row = await manager.getRepository(TokenRecordEntity).findOne({
      where: {
        tokenHash: hashToken(transaction),
        type: 'portal_mfa',
        status: 'active',
      },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (
      !row?.accountId ||
      row.expiresAt.getTime() <= Date.now() ||
      row.metadataJson?.browserBindingHash !== hashToken(binding)
    )
      throw new BadRequestException('Invalid or expired OTP challenge');
    return row;
  }
}
