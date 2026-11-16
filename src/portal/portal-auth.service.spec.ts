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
