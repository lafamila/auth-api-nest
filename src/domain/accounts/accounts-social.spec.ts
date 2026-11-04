import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import {
  DataSource,
  EntityManager,
  getMetadataArgsStorage,
  QueryFailedError,
  QueryRunner,
  Repository,
} from 'typeorm';
import { ADMIN_TEMPORARY_RESET_PASSWORD } from '../../common/crypto/password-policy';
import { AccountEntity } from '../../database/entities/account.entity';
import { TokenRecordEntity } from '../../database/entities/token-record.entity';
import { AllowSocialOnlyAccounts20261104000000 } from '../../database/migrations/20261104000000-AllowSocialOnlyAccounts';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/account.dto';

function setup(overrides: Partial<AccountEntity> = {}) {
  const account = Object.assign(new AccountEntity(), {
    id: 'account-id',
    loginId: null,
    passwordHash: null,
    email: 'social@example.test',
    name: 'Social User',
    status: 'active',
    isSuperAdmin: false,
    passwordResetRequired: false,
    emailVerifiedAt: new Date(),
    lastLoginAt: null,
    ...overrides,
  });
  const accounts = {
    findOneBy: jest.fn().mockResolvedValue(account),
    exists: jest.fn().mockResolvedValue(false),
    save: jest.fn(async (value: AccountEntity) => value),
  };
  const manager = {
    create: jest.fn(
      (_target: typeof AccountEntity, value: Partial<AccountEntity>) =>
        Object.assign(new AccountEntity(), value),
    ),
    save: jest.fn(async (value: AccountEntity) =>
      Object.assign(value, { id: 'created-id' }),
    ),
    getRepository: jest.fn(),
  };
  const dataSource = {
    transaction: jest.fn(
      async (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback(manager as unknown as EntityManager),
    ),
  };
  const passwordService = {
    hash: jest.fn().mockResolvedValue('hashed-password'),
    verify: jest.fn().mockResolvedValue(true),
  };
  const auditLogs = { record: jest.fn().mockResolvedValue(undefined) };
  const tokenRecords = { update: jest.fn().mockResolvedValue(undefined) };
  const subject = new AccountsService(
    accounts as unknown as Repository<AccountEntity>,
    dataSource as unknown as DataSource,
    passwordService,
    auditLogs as unknown as AuditLogsService,
    tokenRecords as unknown as Repository<TokenRecordEntity>,
  );
  return {
    subject,
    account,
    accounts,
    manager,
    transactionManager: manager as unknown as EntityManager,
    dataSource,
    passwordService,
    auditLogs,
    tokenRecords,
  };
}

describe('Social account creation', () => {
  const socialInput = { email: ' Social@Example.TEST ', name: ' Social User ' };

  it('persists NULL local credentials and audits through the caller transaction only', async () => {
    const {
      subject,
      manager,
      transactionManager,
      accounts,
      dataSource,
      passwordService,
      auditLogs,
    } = setup();
    const account = await subject.createSocialAccount(
      socialInput,
      transactionManager,
    );

    expect(manager.create).toHaveBeenCalledWith(AccountEntity, {
      loginId: null,
      passwordHash: null,
      email: 'social@example.test',
      name: 'Social User',
      status: 'active',
      isSuperAdmin: false,
      passwordResetRequired: false,
      emailVerifiedAt: expect.any(Date),
    });
    expect(account.loginId).toBeNull();
    expect(account.passwordHash).toBeNull();
    expect(manager.save).toHaveBeenCalledWith(account);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(accounts.exists).not.toHaveBeenCalled();
    expect(accounts.save).not.toHaveBeenCalled();
    expect(manager.getRepository).not.toHaveBeenCalled();
    expect(passwordService.hash).not.toHaveBeenCalled();
    expect(auditLogs.record).toHaveBeenCalledWith(
      {
        action: 'account.create',
        targetType: 'account',
        targetId: account.id,
        afterJson: expect.objectContaining({
          loginId: null,
          hasLocalCredentials: false,
        }),
      },
      transactionManager,
    );
  });

  it('supports an explicit local ID/password without changing the password or leaking it into the audit', async () => {
    const { subject, transactionManager, passwordService, auditLogs } = setup();
    const password = ' Password!1 ';
    const account = await subject.createSocialAccount(
      { ...socialInput, loginId: ' local-user ', password },
      transactionManager,
    );

    expect(account).toMatchObject({
      loginId: 'local-user',
      passwordHash: 'hashed-password',
      isSuperAdmin: false,
    });
    expect(passwordService.hash).toHaveBeenCalledWith(password);
    expect(auditLogs.record).toHaveBeenCalledWith(
      expect.objectContaining({
        afterJson: expect.objectContaining({ hasLocalCredentials: true }),
      }),
      transactionManager,
    );
    const auditJson = JSON.stringify(auditLogs.record.mock.calls);
    expect(auditJson).not.toContain(password);
    expect(auditJson).not.toContain('hashed-password');
    expect(auditJson).not.toContain('passwordHash');
  });

  it('treats blank optional fields as absent without generating credentials', async () => {
    const { subject, transactionManager, passwordService } = setup();
    const account = await subject.createSocialAccount(
      { ...socialInput, loginId: '  ', password: '' },
      transactionManager,
    );
    expect(account.loginId).toBeNull();
    expect(account.passwordHash).toBeNull();
    expect(passwordService.hash).not.toHaveBeenCalled();
  });

  it.each([
    { loginId: 'local-user' },
    { password: 'Password!1' },
    { loginId: 'local-user', password: '' },
    { loginId: '  ', password: 'Password!1' },
  ])('rejects partial credentials: %j', async (credentials) => {
    const { subject, manager, transactionManager, passwordService, auditLogs } =
      setup();
    await expect(
      subject.createSocialAccount(
        { ...socialInput, ...credentials },
        transactionManager,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(passwordService.hash).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(auditLogs.record).not.toHaveBeenCalled();
  });

  it.each(['short!', 'NoSpecialCharacter', ADMIN_TEMPORARY_RESET_PASSWORD])(
    'applies the existing normal-password policy to %s',
    async (password) => {
      const { subject, manager, transactionManager, passwordService } = setup();
      await expect(
        subject.createSocialAccount(
          { ...socialInput, loginId: 'local-user', password },
          transactionManager,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(passwordService.hash).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it.each([{ name: '  ' }, { email: '  ' }])(
    'rejects blank identity fields: %j',
    async (fields) => {
      const { subject, transactionManager, manager } = setup();
      await expect(
        subject.createSocialAccount(
          { ...socialInput, ...fields },
          transactionManager,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it('maps a database unique race to a conflict without auditing an unsaved account', async () => {
    const { subject, manager, transactionManager, auditLogs } = setup();
    manager.save.mockRejectedValue(
      new QueryFailedError(
        'INSERT INTO accounts',
        [],
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      ),
    );
    await expect(
      subject.createSocialAccount(socialInput, transactionManager),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(auditLogs.record).not.toHaveBeenCalled();
  });

  it('propagates other persistence errors to the caller transaction', async () => {
    const { subject, manager, transactionManager, auditLogs } = setup();
    const error = new QueryFailedError(
      'INSERT INTO accounts',
      [],
      Object.assign(new Error('check violation'), { code: '23514' }),
    );
    manager.save.mockRejectedValue(error);
    await expect(
      subject.createSocialAccount(socialInput, transactionManager),
    ).rejects.toBe(error);
    expect(auditLogs.record).not.toHaveBeenCalled();
  });

  it('propagates audit failure so the caller can roll back account creation', async () => {
    const { subject, transactionManager, auditLogs } = setup();
    const error = new Error('audit failure');
    auditLogs.record.mockRejectedValue(error);
    await expect(
      subject.createSocialAccount(socialInput, transactionManager),
    ).rejects.toBe(error);
  });
});

describe('Local credential boundaries', () => {
  it.each(['', '  ', null, undefined])(
    'fails closed before a login-ID query for %s',
    async (loginId) => {
      const { subject, accounts } = setup();
      expect(
        await subject.findByLoginId(loginId as unknown as string),
      ).toBeNull();
      expect(accounts.findOneBy).not.toHaveBeenCalled();
    },
  );

  it('preserves an existing nonempty login ID exactly', async () => {
    const { subject, accounts } = setup();
    await subject.findByLoginId(' ExistingID ');
    expect(accounts.findOneBy).toHaveBeenCalledWith({
      loginId: ' ExistingID ',
    });
  });

  describe.each([
    'authenticate',
    'authenticateIgnoringResetRequirement',
  ] as const)('%s', (method) => {
    it.each([
      { loginId: null, passwordHash: null },
      { loginId: 'local-user', passwordHash: null },
      { loginId: null, passwordHash: 'hash' },
      { loginId: '', passwordHash: 'hash' },
      { loginId: 'local-user', passwordHash: '' },
    ])(
      'rejects missing stored credentials without hashing: %j',
      async (credentials) => {
        const { subject, passwordService, accounts } = setup(credentials);
        await expect(
          subject[method]('local-user', 'Password!1'),
        ).rejects.toThrow('Invalid credentials');
        expect(passwordService.verify).not.toHaveBeenCalled();
        expect(accounts.save).not.toHaveBeenCalled();
      },
    );

    it.each(['', '  ', null, undefined])(
      'rejects empty login input %s before querying',
      async (loginId) => {
        const { subject, accounts, passwordService } = setup();
        await expect(
          subject[method](loginId as unknown as string, 'Password!1'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(accounts.findOneBy).not.toHaveBeenCalled();
        expect(passwordService.verify).not.toHaveBeenCalled();
      },
    );

    it.each(['', null, undefined])(
      'rejects empty password input %s before querying',
      async (password) => {
        const { subject, accounts, passwordService } = setup();
        await expect(
          subject[method]('local-user', password as unknown as string),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(accounts.findOneBy).not.toHaveBeenCalled();
        expect(passwordService.verify).not.toHaveBeenCalled();
      },
    );

    it('continues authenticating a valid local account', async () => {
      const { subject, account, passwordService } = setup({
        loginId: 'local-user',
        passwordHash: 'hash',
      });
      expect(await subject[method]('local-user', 'Password!1')).toBe(account);
      expect(passwordService.verify).toHaveBeenCalledWith('hash', 'Password!1');
    });

    it.each(['locked', 'disabled'] as const)(
      'preserves denial for %s accounts',
      async (status) => {
        const { subject, passwordService } = setup({
          loginId: 'local-user',
          passwordHash: 'hash',
          status,
        });
        await expect(
          subject[method]('local-user', 'Password!1'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(passwordService.verify).not.toHaveBeenCalled();
      },
    );

    it('preserves denial for an incorrect password', async () => {
      const { subject, passwordService, accounts } = setup({
        loginId: 'local-user',
        passwordHash: 'hash',
      });
      passwordService.verify.mockResolvedValue(false);
      await expect(
        subject[method]('local-user', 'Incorrect!1'),
      ).rejects.toThrow('Invalid credentials');
      expect(accounts.save).not.toHaveBeenCalled();
    });
  });

  it.each([undefined, 'New-password!1'])(
    'does not add local credentials to a social-only account through resetPassword(%s)',
    async (password) => {
      const {
        subject,
        accounts,
        passwordService,
        tokenRecords,
        auditLogs,
        account,
      } = setup();
      await expect(
        subject.resetPassword(account.id, password),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(account.passwordHash).toBeNull();
      expect(passwordService.hash).not.toHaveBeenCalled();
      expect(accounts.save).not.toHaveBeenCalled();
      expect(tokenRecords.update).not.toHaveBeenCalled();
      expect(auditLogs.record).not.toHaveBeenCalled();
    },
  );

  it('keeps forced resets and refresh revocation for local accounts', async () => {
    const {
      subject,
      account,
      accounts,
      passwordService,
      tokenRecords,
      auditLogs,
    } = setup({ loginId: 'local-user', passwordHash: 'old-hash' });
    await subject.resetPassword(account.id);
    expect(passwordService.hash).toHaveBeenCalledWith(
      ADMIN_TEMPORARY_RESET_PASSWORD,
    );
    expect(account.passwordResetRequired).toBe(true);
    expect(accounts.save).toHaveBeenCalledWith(account);
    expect(tokenRecords.update).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: account.id, type: 'refresh_token' }),
      { status: 'revoked' },
    );
    expect(auditLogs.record).toHaveBeenCalledWith({
      action: 'account.reset_password',
      targetType: 'account',
      targetId: account.id,
    });
  });

  it('preserves the local forced-reset authentication gate and completion path', async () => {
    const { subject, account, accounts } = setup({
      loginId: 'local-user',
      passwordHash: 'hash',
      passwordResetRequired: true,
    });
    await expect(
      subject.authenticate('local-user', ADMIN_TEMPORARY_RESET_PASSWORD),
    ).rejects.toThrow('Password reset is required');
    expect(accounts.save).not.toHaveBeenCalled();
    expect(
      await subject.authenticateIgnoringResetRequirement(
        'local-user',
        ADMIN_TEMPORARY_RESET_PASSWORD,
      ),
    ).toBe(account);
    expect(
      await subject.completePasswordReset(
        'local-user',
        ADMIN_TEMPORARY_RESET_PASSWORD,
        'New-password!1',
      ),
    ).toBe(account);
    expect(account.passwordResetRequired).toBe(false);
    expect(account.passwordHash).toBe('hashed-password');
    expect(account.lastLoginAt).toBeInstanceOf(Date);
  });

  it('keeps the local create path and explicit superadmin option unchanged', async () => {
    const {
      subject,
      transactionManager,
      dataSource,
      passwordService,
      auditLogs,
    } = setup();
    const input = {
      loginId: 'Local-ID',
      name: 'Local User',
      email: 'Local@Example.test',
      password: 'Password!1',
      isSuperAdmin: true,
    };
    const account = await subject.create(input, 'admin-id');
    expect(account).toMatchObject({
      loginId: input.loginId,
      email: input.email,
      isSuperAdmin: true,
      passwordHash: 'hashed-password',
      emailVerifiedAt: null,
    });
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(passwordService.hash).toHaveBeenCalledWith(input.password);
    expect(auditLogs.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAccountId: 'admin-id',
        afterJson: expect.objectContaining({ hasLocalCredentials: true }),
      }),
      transactionManager,
    );
  });

  it('keeps local signup DTO credentials mandatory', async () => {
    const input = Object.assign(new CreateAccountDto(), {
      name: 'User',
      email: 'user@example.test',
    });
    const errors = await validate(input);
    expect(errors.map((error) => error.property).sort()).toEqual([
      'loginId',
      'password',
    ]);
  });

  it.each([
    { loginId: null, passwordHash: null, expected: false },
    { loginId: 'local-user', passwordHash: 'hash', expected: true },
    { loginId: 'local-user', passwordHash: null, expected: false },
    { loginId: '', passwordHash: 'hash', expected: false },
  ])(
    'exposes credential availability without a hash: %j',
    ({ expected, ...credentials }) => {
      const { subject, account } = setup(credentials);
      const safe = subject.safeAccount(account);
      expect(safe.hasLocalCredentials).toBe(expected);
      expect(safe).not.toHaveProperty('passwordHash');
      expect(safe).not.toHaveProperty('password');
    },
  );
});

describe('Social-only credential schema', () => {
  it.each(['loginId', 'passwordHash'])(
    'uses an explicitly nullable varchar for %s',
    (propertyName) => {
      const column = getMetadataArgsStorage().columns.find(
        (item) =>
          item.target === AccountEntity && item.propertyName === propertyName,
      );
      expect(column?.options).toMatchObject({
        type: 'varchar',
        nullable: true,
      });
    },
  );

  it('declares the credential pair and reset constraints in the entity and forward migration', async () => {
    const checks = getMetadataArgsStorage().checks.filter(
      (item) => item.target === AccountEntity,
    );
    const query = jest.fn().mockResolvedValue(undefined);
    await new AllowSocialOnlyAccounts20261104000000().up({
      query,
    } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ALTER COLUMN login_id DROP NOT NULL'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ALTER COLUMN password_hash DROP NOT NULL'),
    );
    for (const check of checks) {
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining(`ADD CONSTRAINT ${check.name}`),
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining(`CHECK (${check.expression})`),
      );
    }
    expect(checks).toHaveLength(2);
  });

  it('guards rollback with an exception instead of fabricating or deleting credentials', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AllowSocialOnlyAccounts20261104000000().down({
      query,
    } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('WHERE login_id IS NULL OR password_hash IS NULL');
    expect(sql).toContain(
      "RAISE EXCEPTION 'Cannot revert AllowSocialOnlyAccounts while social-only accounts exist'",
    );
    expect(sql.indexOf('RAISE EXCEPTION')).toBeLessThan(
      sql.indexOf('ALTER TABLE accounts'),
    );
    expect(sql).toContain('ALTER COLUMN login_id SET NOT NULL');
    expect(sql).toContain('ALTER COLUMN password_hash SET NOT NULL');
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
  });
});
