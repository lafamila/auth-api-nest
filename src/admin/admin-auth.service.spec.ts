import { UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { DataSource, EntityManager } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { AdminSessionEntity } from '../database/entities/admin-session.entity';
import { AccountsService } from '../domain/accounts/accounts.service';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';
import { AdminAuthService } from './admin-auth.service';
import { AdminMfaThrottleService } from './admin-mfa-throttle.service';

describe('AdminAuthService login throttling', () => {
  it('commits a shared throttle failure before raising the OTP 401', async () => {
    const authenticated = account(7);
    const manager = {} as EntityManager;
    const transaction = jest.fn(
      async (work: (activeManager: EntityManager) => Promise<unknown>) =>
        work(manager),
    );
    const checkGuessAllowed = jest.fn().mockResolvedValue({
      allowed: true,
      kind: 'failure',
      blockedBy: null,
      accountCount: 0,
      accountLimit: 5,
      ipCount: 0,
      ipLimit: 30,
      retryAt: null,
    });
    const recordFailure = jest.fn().mockResolvedValue({
      allowed: false,
      kind: 'failure',
      blockedBy: 'account',
      accountCount: 5,
      accountLimit: 5,
      ipCount: 5,
      ipLimit: 30,
      retryAt: new Date(),
    });
    const subject = new AdminAuthService(
      {} as never,
      {
        findOneBy: jest.fn().mockResolvedValue({
          accountId: authenticated.id,
          encryptedOtpSecret: 'encrypted',
        }),
      } as never,
      {} as never,
      { transaction } as unknown as DataSource,
      {
        authenticateIgnoringResetRequirement: jest
          .fn()
          .mockResolvedValue(authenticated),
      } as unknown as AccountsService,
      {} as never,
      { decrypt: jest.fn().mockReturnValue('secret') } as never,
      { verify: jest.fn().mockReturnValue(false) } as never,
      {
        issuerUrl: 'https://auth.example.com',
      } as AppConfigService,
      {} as AuditLogsService,
      {
        checkGuessAllowed,
        recordFailure,
      } as unknown as AdminMfaThrottleService,
    );
    const request = {
      ip: '203.0.113.21',
      header: jest.fn().mockReturnValue(undefined),
    } as unknown as Request;

    await expect(
      subject.login(
        { loginId: 'admin', password: 'password', otpCode: '000000' },
        request,
        {} as Response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(checkGuessAllowed).toHaveBeenCalledWith(
      authenticated.id,
      request,
      manager,
    );
    expect(recordFailure).toHaveBeenCalledWith(
      authenticated.id,
      request,
      manager,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe('AdminAuthService session issuance', () => {
  it('locks and refetches the account before inserting a session', async () => {
    const authenticated = account(7);
    const fresh = { ...authenticated, name: 'Fresh name' };
    const harness = setup(fresh);

    await harness.subject.issueVerifiedSession(
      authenticated,
      harness.request,
      harness.response,
    );

    expect(harness.managerFindOne).toHaveBeenCalledWith(AccountEntity, {
      where: { id: authenticated.id },
      lock: { mode: 'pessimistic_write' },
    });
    expect(harness.sessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        account: fresh,
        accountId: fresh.id,
        credentialVersion: 7,
      }),
    );
    expect(harness.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.session.create' }),
      harness.manager,
    );
    expect(harness.responseCookie).toHaveBeenCalled();
  });

  it('does not insert or set a cookie when credentials changed after authentication', async () => {
    const authenticated = account(7);
    const harness = setup(account(8));

    await expect(
      harness.subject.issueVerifiedSession(
        authenticated,
        harness.request,
        harness.response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(harness.sessionSave).not.toHaveBeenCalled();
    expect(harness.auditRecord).not.toHaveBeenCalled();
    expect(harness.responseCookie).not.toHaveBeenCalled();
  });
});

function setup(freshAccount: AccountEntity) {
  const sessionCreate = jest.fn((input: Partial<AdminSessionEntity>) => ({
    id: 'session-1',
    ...input,
  }));
  const sessionSave = jest.fn(async (input: AdminSessionEntity) => input);
  const sessions = {
    create: sessionCreate,
    save: sessionSave,
  };
  const managerFindOne = jest.fn().mockResolvedValue(freshAccount);
  const manager = {
    findOne: managerFindOne,
    getRepository: jest.fn().mockReturnValue(sessions),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn(
      async (work: (activeManager: EntityManager) => Promise<unknown>) =>
        work(manager),
    ),
  } as unknown as DataSource;
  const accounts = {
    safeAccount: jest.fn((value: AccountEntity) => value),
  } as unknown as AccountsService;
  const auditRecord = jest.fn().mockResolvedValue(undefined);
  const auditLogs = { record: auditRecord } as unknown as AuditLogsService;
  const config = {
    adminSessionCookieName: 'admin-session',
    nodeEnv: 'test',
  } as AppConfigService;
  const request = {
    ip: '203.0.113.20',
    header: jest.fn().mockReturnValue(undefined),
  } as unknown as Request;
  const responseCookie = jest.fn();
  const response = { cookie: responseCookie } as unknown as Response;
  const subject = new AdminAuthService(
    {} as never,
    {} as never,
    {} as never,
    dataSource,
    accounts,
    {} as never,
    {} as never,
    {} as never,
    config,
    auditLogs,
    {} as AdminMfaThrottleService,
  );
  return {
    subject,
    manager: manager as jest.Mocked<EntityManager>,
    managerFindOne,
    sessionCreate,
    sessionSave,
    auditRecord,
    request,
    response: response as jest.Mocked<Response>,
    responseCookie,
  };
}

function account(credentialVersion: number): AccountEntity {
  return {
    id: 'account-1',
    loginId: 'admin',
    name: 'Admin',
    email: 'admin@example.com',
    passwordHash: 'hash',
    status: 'active',
    isSuperAdmin: true,
    passwordResetRequired: false,
    credentialVersion,
    emailVerifiedAt: new Date(),
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
