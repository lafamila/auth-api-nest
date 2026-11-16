import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  getMetadataArgsStorage,
  In,
  IsNull,
  QueryRunner,
  Repository,
} from 'typeorm';
import { AccountEntity } from '../../database/entities/account.entity';
import { AdminSessionEntity } from '../../database/entities/admin-session.entity';
import { TokenRecordEntity } from '../../database/entities/token-record.entity';
import { AddAccountCredentialVersion20261116000000 } from '../../database/migrations/20261116000000-AddAccountCredentialVersion';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AccountsService } from './accounts.service';

function setup(overrides: Partial<AccountEntity> = {}) {
  const stored = Object.assign(new AccountEntity(), {
    id: 'account-id',
    loginId: 'local-user',
    passwordHash: 'old-hash',
    name: 'Account User',
    email: 'user@example.test',
    status: 'active',
    isSuperAdmin: false,
    passwordResetRequired: false,
    credentialVersion: 2,
    ...overrides,
  });
  const accounts = {
    findOneBy: jest.fn(async () => ({ ...stored })),
    findOne: jest.fn(async () => ({ ...stored })),
    update: jest.fn(async (_id: string, changes: Partial<AccountEntity>) => {
      Object.assign(stored, changes);
      return { affected: 1 };
    }),
    save: jest.fn(),
    countBy: jest.fn().mockResolvedValue(2),
  };
  const tokens = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const admins = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const getRepository = jest.fn((entity: unknown) => {
    if (entity === AccountEntity) return accounts;
    if (entity === TokenRecordEntity) return tokens;
    if (entity === AdminSessionEntity) return admins;
    throw new Error('Unexpected repository');
  });
  const manager = { getRepository } as unknown as EntityManager;
  const dataSource = {
    getRepository,
    transaction: jest.fn(
      async (callback: (transaction: EntityManager) => Promise<unknown>) =>
        callback(manager),
    ),
  };
  const passwords = {
    hash: jest.fn().mockResolvedValue('new-hash'),
    verify: jest.fn().mockResolvedValue(true),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const subject = new AccountsService(
    accounts as unknown as Repository<AccountEntity>,
    dataSource as unknown as DataSource,
    passwords,
    audit as unknown as AuditLogsService,
    tokens as unknown as Repository<TokenRecordEntity>,
  );
  return {
    stored,
    accounts,
    tokens,
    admins,
    manager,
    dataSource,
    passwords,
    audit,
    subject,
  };
}

function expectRevoked(
  context: ReturnType<typeof setup>,
  accountId = context.stored.id,
) {
  expect(context.tokens.update).toHaveBeenCalledWith(
    {
      accountId,
      type: In([
        'refresh_token',
        'sso_session',
        'portal_session',
        'portal_mfa',
        'authorization_code',
        'authorization_login',
      ]),
      status: In(['active', 'used']),
    },
    { status: 'revoked' },
  );
  expect(context.admins.update).toHaveBeenCalledWith(
    { accountId, revokedAt: IsNull() },
    { revokedAt: expect.any(Date) },
  );
}

describe('Account credential changes', () => {
  it.each([
    { password: undefined, resetRequired: true },
    { password: 'New-password!1', resetRequired: false },
  ])('locks and narrowly resets local credentials: %j', async (input) => {
    const context = setup();
    const { subject, accounts, stored, dataSource, audit, manager } = context;
    await subject.resetPassword(stored.id, input.password);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(accounts.findOne).toHaveBeenCalledWith({
      where: { id: stored.id },
      lock: { mode: 'pessimistic_write' },
    });
    expect(accounts.update).toHaveBeenCalledWith(stored.id, {
      passwordHash: 'new-hash',
      passwordResetRequired: input.resetRequired,
      credentialVersion: 3,
    });
    expect(accounts.save).not.toHaveBeenCalled();
    expect(stored.loginId).toBe('local-user');
    expectRevoked(context);
    expect(audit.record).toHaveBeenCalledWith(
      {
        action: 'account.reset_password',
        targetType: 'account',
        targetId: stored.id,
      },
      manager,
    );
  });

  it('increments the locked version and preserves a concurrent disable/profile update', async () => {
    const context = setup();
    const { subject, passwords, stored, accounts } = context;
    passwords.hash.mockImplementationOnce(async () => {
      stored.credentialVersion = 9;
      stored.status = 'disabled';
      stored.name = 'Concurrent name';
      return 'new-hash';
    });
    await subject.resetPassword(stored.id);
    expect(stored).toMatchObject({
      credentialVersion: 10,
      status: 'disabled',
      name: 'Concurrent name',
    });
    expect(accounts.save).not.toHaveBeenCalled();
    expectRevoked(context);
  });

  it.each([
    { loginId: null, passwordHash: null },
    { loginId: null, passwordHash: 'hash' },
    { loginId: 'local-user', passwordHash: null },
  ])('never fabricates local credentials: %j', async (credentials) => {
    const { subject, stored, accounts, passwords, dataSource } =
      setup(credentials);
    await expect(subject.resetPassword(stored.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(passwords.hash).not.toHaveBeenCalled();
    expect(accounts.update).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rechecks credential availability after taking the lock', async () => {
    const { subject, stored, accounts, passwords, tokens } = setup();
    passwords.hash.mockImplementationOnce(async () => {
      stored.loginId = null;
      stored.passwordHash = null;
      return 'new-hash';
    });
    await expect(subject.resetPassword(stored.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(accounts.update).not.toHaveBeenCalled();
    expect(tokens.update).not.toHaveBeenCalled();
  });

  it('fails closed when the account was deleted while hashing', async () => {
    const { subject, stored, accounts, tokens } = setup();
    accounts.findOne.mockResolvedValueOnce(null as unknown as AccountEntity);
    await expect(subject.resetPassword(stored.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(accounts.update).not.toHaveBeenCalled();
    expect(tokens.update).not.toHaveBeenCalled();
  });

  it.each(['tokens', 'admins', 'audit'] as const)(
    'propagates %s failure through the reset transaction',
    async (failingStep) => {
      const context = setup();
      const error = new Error('Persistence failed');
      if (failingStep === 'audit') {
        context.audit.record.mockRejectedValueOnce(error);
      } else {
        context[failingStep].update.mockRejectedValueOnce(error);
      }
      await expect(
        context.subject.resetPassword(context.stored.id),
      ).rejects.toBe(error);
      expect(context.dataSource.transaction).toHaveBeenCalledTimes(1);
      if (failingStep !== 'audit') {
        expect(context.audit.record).not.toHaveBeenCalled();
      }
    },
  );

  it('does not overwrite a concurrent reset while updating a login timestamp', async () => {
    const { subject, passwords, accounts, stored } = setup();
    passwords.verify.mockImplementationOnce(async () => {
      stored.credentialVersion = 3;
      stored.passwordHash = 'concurrent-hash';
      stored.passwordResetRequired = true;
      stored.status = 'disabled';
      return true;
    });
    const authenticated = await subject.authenticate(
      'local-user',
      'Password!1',
    );
    expect(authenticated.credentialVersion).toBe(2);
    expect(accounts.update).toHaveBeenCalledWith(stored.id, {
      lastLoginAt: expect.any(Date),
    });
    expect(stored).toMatchObject({
      credentialVersion: 3,
      passwordHash: 'concurrent-hash',
      passwordResetRequired: true,
      status: 'disabled',
    });
    expect(accounts.save).not.toHaveBeenCalled();
  });

  it('completes a forced reset with version advancement and session revocation', async () => {
    const context = setup({ passwordResetRequired: true });
    const result = await context.subject.completePasswordReset(
      'local-user',
      '123456789',
      'New-password!1',
    );
    expect(result).toMatchObject({
      passwordHash: 'new-hash',
      passwordResetRequired: false,
      credentialVersion: 3,
      lastLoginAt: expect.any(Date),
    });
    expect(context.accounts.update).toHaveBeenCalledWith(result.id, {
      passwordHash: 'new-hash',
      passwordResetRequired: false,
      credentialVersion: 3,
      lastLoginAt: expect.any(Date),
    });
    expectRevoked(context);
  });

  it.each([
    { credentialVersion: 3 },
    { passwordHash: 'concurrent-hash' },
    { status: 'disabled' as const },
    { status: 'locked' as const },
    { loginId: null, passwordHash: null },
  ])(
    'rejects stale forced-reset credentials after locking: %j',
    async (changes) => {
      const { subject, stored, passwords, accounts, tokens } = setup({
        passwordResetRequired: true,
      });
      passwords.hash.mockImplementationOnce(async () => {
        Object.assign(stored, changes);
        return 'new-hash';
      });
      await expect(
        subject.completePasswordReset(
          'local-user',
          '123456789',
          'New-password!1',
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(accounts.update).not.toHaveBeenCalled();
      expect(tokens.update).not.toHaveBeenCalled();
    },
  );
});

describe('Account-wide session revocation', () => {
  it('uses the caller transaction without changing the account row', async () => {
    const context = setup();
    await context.subject.revokeAccountSessions(
      context.stored.id,
      context.manager,
    );
    expectRevoked(context);
    expect(context.dataSource.transaction).not.toHaveBeenCalled();
    expect(context.accounts.update).not.toHaveBeenCalled();
    expect(context.accounts.save).not.toHaveBeenCalled();
  });

  it('supports revocation without an explicit transaction manager', async () => {
    const context = setup();
    await context.subject.revokeAccountSessions(context.stored.id);
    expectRevoked(context);
  });

  it('disables with a narrow status update and revokes all session families', async () => {
    const context = setup();
    const result = await context.subject.update(context.stored.id, {
      status: 'disabled',
    });
    expect(result.status).toBe('disabled');
    expect(context.accounts.update).toHaveBeenCalledWith(result.id, {
      status: 'disabled',
      credentialVersion: 3,
    });
    expect(context.accounts.save).not.toHaveBeenCalled();
    expectRevoked(context);
  });

  it.each(['disabled', 'locked'] as const)(
    'keeps legacy version-zero sessions invalid after %s and reenabling',
    async (status) => {
      const context = setup({ credentialVersion: 0 });
      await context.subject.update(context.stored.id, { status });
      await context.subject.update(context.stored.id, { status: 'active' });
      expect(context.stored).toMatchObject({
        status: 'active',
        credentialVersion: 1,
      });
      expect(context.accounts.update).toHaveBeenLastCalledWith(
        context.stored.id,
        {
          status: 'active',
        },
      );
    },
  );

  it.each([{ name: 'Renamed' }, { email: 'new@example.test' }, {}])(
    'preserves ordinary non-disabling updates: %j',
    async (input) => {
      const context = setup();
      const result = await context.subject.update(context.stored.id, input);
      expect(result).toMatchObject(input);
      expect(context.tokens.update).not.toHaveBeenCalled();
      expect(context.admins.update).not.toHaveBeenCalled();
      expect(context.accounts.save).not.toHaveBeenCalled();
    },
  );
});

describe('Credential version schema', () => {
  it('uses a nonnegative integer defaulting to zero without a DB token enum', () => {
    const metadata = getMetadataArgsStorage();
    expect(
      metadata.columns.find(
        (column) =>
          column.target === AccountEntity &&
          column.propertyName === 'credentialVersion',
      )?.options,
    ).toMatchObject({
      name: 'credential_version',
      type: 'integer',
      default: 0,
    });
    expect(metadata.checks).toContainEqual(
      expect.objectContaining({
        target: AccountEntity,
        name: 'chk_accounts_credential_version_nonnegative',
        expression: 'credential_version >= 0',
      }),
    );
    const typeColumn = metadata.columns.find(
      (column) =>
        column.target === TokenRecordEntity && column.propertyName === 'type',
    );
    expect(typeColumn?.options.enum).toBeUndefined();
  });

  it('adds only a zero-default version and its nonnegative constraint', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddAccountCredentialVersion20261116000000().up({
      query,
    } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain(
      'ADD COLUMN credential_version integer NOT NULL DEFAULT 0',
    );
    expect(sql).toContain('ALTER TABLE admin_sessions');
    expect(sql).toContain('CHECK (credential_version >= 0)');
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT|DROP)\b/i);
  });

  it('locks before checking and refuses rollback once any credentials changed', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddAccountCredentialVersion20261116000000().down({
      query,
    } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain(
      'LOCK TABLE accounts, admin_sessions IN ACCESS EXCLUSIVE MODE',
    );
    expect(sql).toContain('WHERE credential_version > 0');
    expect(sql).toContain(
      'SELECT 1 FROM accounts WHERE credential_version > 0',
    );
    expect(sql).toContain(
      'SELECT 1 FROM admin_sessions WHERE credential_version > 0',
    );
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql.indexOf('LOCK TABLE')).toBeLessThan(sql.indexOf('IF EXISTS'));
    expect(sql.indexOf('RAISE EXCEPTION')).toBeLessThan(
      sql.indexOf('DROP COLUMN'),
    );
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
  });
});
