import { UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { DataSource, EntityManager } from 'typeorm';
import { AdminAuthService } from '../admin/admin-auth.service';
import {
  AdminMfaThrottleResult,
  AdminMfaThrottleService,
} from '../admin/admin-mfa-throttle.service';
import { hashToken } from '../common/crypto/token-hash';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { SsoSessionService } from '../oidc/sso-session.service';
import { PortalAuthService } from './portal-auth.service';
import { PortalSessionService } from './portal-session.service';

describe('PortalAuthService OTP verification', () => {
  it('records a failed OTP with the active transaction before raising 401', async () => {
    const transaction = 'portal-transaction';
    const binding = 'browser-binding';
    const account = superAdmin();
    const challenge = {
      id: 'challenge-1',
      tokenHash: hashToken(transaction),
      type: 'portal_mfa',
      status: 'active',
      familyId: null,
      accountId: account.id,
      clientId: 'account-portal',
      serviceId: null,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      metadataJson: {
        browserBindingHash: hashToken(binding),
        credentialVersion: account.credentialVersion,
        attempts: 0,
      },
    } as TokenRecordEntity;
    const repository = {
      findOne: jest.fn().mockResolvedValue(challenge),
    };
    const managerSave = jest.fn().mockResolvedValue(challenge);
    const manager = {
      getRepository: jest.fn().mockReturnValue(repository),
      findOneOrFail: jest.fn().mockResolvedValue(account),
      save: managerSave,
      delete: jest.fn(),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(
        async (work: (activeManager: EntityManager) => Promise<unknown>) =>
          work(manager),
      ),
    } as unknown as DataSource;
    const admin = {
      verifyAccountOtp: jest.fn().mockResolvedValue(false),
    } as unknown as AdminAuthService;
    const allowed = throttleResult(true);
    const failure = throttleResult(false);
    const checkGuessAllowed = jest.fn().mockResolvedValue(allowed);
    const recordFailure = jest.fn().mockResolvedValue(failure);
    const mfaThrottle = {
      checkGuessAllowed,
      recordFailure,
      auditBlocked: jest.fn(),
    } as unknown as AdminMfaThrottleService;
    const config = { nodeEnv: 'test' } as AppConfigService;
    const subject = new PortalAuthService(
      dataSource,
      {} as never,
      {} as PortalSessionService,
      admin,
      mfaThrottle,
      {} as SsoSessionService,
      config,
    );
    const request = {
      signedCookies: {
        [subject.cookieName(transaction)]: binding,
      },
      header: jest.fn().mockReturnValue(undefined),
      ip: '203.0.113.30',
    } as unknown as Request;

    await expect(
      subject.verifyOtp(transaction, '000000', request, {} as Response),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(checkGuessAllowed).toHaveBeenCalledWith(
      account.id,
      request,
      manager,
    );
    expect(recordFailure).toHaveBeenCalledWith(account.id, request, manager);
    expect(managerSave).toHaveBeenCalledWith(
      expect.objectContaining({
        metadataJson: expect.objectContaining({ attempts: 1 }),
      }),
    );
  });
});

function throttleResult(allowed: boolean): AdminMfaThrottleResult {
  return {
    allowed,
    kind: 'failure',
    blockedBy: allowed ? null : 'account',
    accountCount: allowed ? 0 : 5,
    accountLimit: 5,
    ipCount: allowed ? 0 : 5,
    ipLimit: 30,
    retryAt: allowed ? null : new Date(Date.now() + 60_000),
  };
}

function superAdmin(): AccountEntity {
  return {
    id: 'account-1',
    loginId: 'admin',
    name: 'Admin',
    email: 'admin@example.com',
    passwordHash: 'hash',
    status: 'active',
    isSuperAdmin: true,
    passwordResetRequired: false,
    credentialVersion: 3,
    emailVerifiedAt: new Date(),
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('PortalAuthService authentication provenance', () => {
  function setup() {
    const sessions = {
      clear: jest.fn(),
      read: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    };
    const sso = {
      create: jest.fn(),
      clear: jest.fn(),
      context: jest.fn().mockResolvedValue(null),
    };
    const admin = {
      logout: jest.fn(),
      verifyAccountOtp: jest.fn().mockResolvedValue(true),
      issueVerifiedSession: jest.fn(
        async (_account: AccountEntity, request: Request) => {
          void _account;
          Object.assign(request, { adminSession: { id: 'otp-session' } });
        },
      ),
    };
    const challenge: TokenRecordEntity = Object.assign(
      new TokenRecordEntity(),
      {
        id: 'challenge',
        accountId: 'account-1',
        expiresAt: new Date(Date.now() + 60_000),
        metadataJson: {
          browserBindingHash: hashToken('browser'),
          credentialVersion: 3,
          method: 'kakao',
          attempts: 0,
        },
      },
    );
    const manager = {
      getRepository: () => ({ findOne: async () => challenge }),
      findOneOrFail: async () => superAdmin(),
      delete: jest.fn(),
    };
    const subject = new PortalAuthService(
      {
        transaction: async (work: (manager: unknown) => Promise<unknown>) =>
          work(manager),
      } as never,
      { insert: jest.fn() } as never,
      sessions as never,
      admin as never,
      { checkGuessAllowed: async () => throttleResult(true) } as never,
      sso as never,
      { nodeEnv: 'test' } as AppConfigService,
    );
    const request = {
      signedCookies: { [subject.cookieName('transaction')]: 'browser' },
    } as unknown as Request;
    const response = { clearCookie: jest.fn() } as unknown as Response;
    return { subject, sessions, sso, admin, challenge, request, response };
  }

  it.each(['local', 'google', 'kakao', 'naver'] as const)(
    'propagates primary %s authentication to both portal and SSO sessions',
    async (method) => {
      const f = setup();
      const account = { ...superAdmin(), isSuperAdmin: false };
      await f.subject.completePrimary(
        account,
        f.request,
        f.response,
        undefined,
        method,
      );
      expect(f.sessions.create).toHaveBeenCalledWith(account, f.response, {
        method,
      });
      expect(f.sso.create).toHaveBeenCalledWith(account, f.response, method);
    },
  );

  it.each(['kakao', undefined])(
    'preserves OTP challenge provenance without a local fallback: %s',
    async (method) => {
      const f = setup();
      f.challenge.metadataJson!.method = method;
      await f.subject.verifyOtp('transaction', '123456', f.request, f.response);
      expect(f.sso.create).toHaveBeenCalledWith(
        expect.anything(),
        f.response,
        method ?? 'legacy',
      );
    },
  );

  it('clears only matching Kakao SSO and portal context, not an unrelated admin cookie', async () => {
    const f = setup();
    f.sso.context.mockResolvedValue({
      accountId: 'account-1',
      authenticationMethod: 'kakao',
    });
    f.sessions.read.mockResolvedValue({
      account: { ...superAdmin(), isSuperAdmin: false },
      session: { metadataJson: { method: 'kakao' } },
    });
    await f.subject.signOutKakao('account-1', f.request, f.response);
    expect(f.sso.clear).toHaveBeenCalledWith(f.request, f.response);
    expect(f.sessions.clear).toHaveBeenCalledWith(f.request, f.response);
    expect(f.admin.logout).not.toHaveBeenCalled();
  });

  it.each(['local', 'google', 'legacy'])(
    'preserves another/local P1 session on denied Kakao authentication: %s',
    async (method) => {
      const f = setup();
      f.sso.context.mockResolvedValue({
        accountId: 'other-account',
        authenticationMethod: method,
      });
      f.sessions.read.mockResolvedValue({
        account: superAdmin(),
        session: { metadataJson: { method: 'local' } },
      });
      await f.subject.signOutKakao('denied-account', f.request, f.response);
      expect(f.sso.clear).not.toHaveBeenCalled();
      expect(f.sessions.clear).not.toHaveBeenCalled();
      expect(f.admin.logout).not.toHaveBeenCalled();
    },
  );
});
