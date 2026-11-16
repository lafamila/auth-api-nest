import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  FindOperator,
  FindOneOptions,
  QueryFailedError,
} from 'typeorm';
import { AppConfigService } from '../config/app-config.service';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { AccountEntity } from '../database/entities/account.entity';
import { EmailVerificationEntity } from '../database/entities/email-verification.entity';
import { ServicePermissionDefinitionEntity } from '../database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../database/entities/service.entity';
import { SocialIdentityEntity } from '../database/entities/social-identity.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { AccountsService } from '../domain/accounts/accounts.service';
import { EmailDeliveryService } from '../signup/email-delivery.service';
import { SocialProvidersService } from '../social/social-providers.service';
import { PortalProfileService } from './portal-profile.service';
import { PortalActor, RECENT_AUTH_MS } from './portal.types';

const NOW = new Date('2026-11-16T05:00:00.000Z');
const EMAIL_INPUT = {
  email: ' New@Example.test ',
  currentPassword: 'Current!password',
};
const PASSWORD_INPUT = {
  password: 'Next!password',
  passwordConfirm: 'Next!password',
  currentPassword: 'Current!password',
};

function setup(overrides: Partial<AccountEntity> = {}) {
  const account = Object.assign(new AccountEntity(), {
    id: 'account-id',
    loginId: 'Existing-ID',
    passwordHash: 'current-password-hash',
    credentialVersion: 2,
    email: 'old@example.test',
    name: 'Immutable Name',
    status: 'active',
    isSuperAdmin: true,
    passwordResetRequired: false,
    emailVerifiedAt: new Date('2026-10-01T00:00:00Z'),
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    lastLoginAt: null,
    ...overrides,
  });
  const actor: PortalActor = {
    account: Object.assign(new AccountEntity(), account),
    session: Object.assign(new TokenRecordEntity(), {
      id: 'portal-session',
      type: 'portal_session',
      accountId: account.id,
      tokenHash: 'hashed-portal-session',
      metadataJson: { authenticatedAt: NOW.toISOString() },
      createdAt: NOW,
    }),
    csrfToken: 'csrf-token',
  };
  let verification: EmailVerificationEntity | null = null;
  let latest: EmailVerificationEntity | null = null;
  const accountsRepository = {
    findOne: jest.fn().mockImplementation(async () => account),
    findOneBy: jest.fn().mockResolvedValue(null),
    exists: jest.fn().mockResolvedValue(false),
    update: jest.fn(async (_id: string, patch: Partial<AccountEntity>) => {
      Object.assign(account, patch);
    }),
  };
  const verifications = {
    create: jest.fn((value: Partial<EmailVerificationEntity>) =>
      Object.assign(new EmailVerificationEntity(), value),
    ),
    save: jest.fn(async (value: EmailVerificationEntity) => {
      verification = Object.assign(value, {
        id: '7819567a-f64a-46f5-8595-8b47c4b27a96',
        createdAt: new Date(),
      });
      latest = verification;
      return verification;
    }),
    findOne: jest.fn(
      async (options: FindOneOptions<EmailVerificationEntity>) =>
        Array.isArray(options.where) ? latest : verification,
    ),
    countBy: jest.fn().mockResolvedValue(0),
    increment: jest.fn(async () => {
      verification!.attemptCount += 1;
    }),
    update: jest.fn(
      async (_id: string, patch: Partial<EmailVerificationEntity>) => {
        Object.assign(verification!, patch);
      },
    ),
  };
  const assignments = { find: jest.fn().mockResolvedValue([]) };
  const identities = { find: jest.fn().mockResolvedValue([]) };
  const repositories = new Map<unknown, unknown>([
    [AccountEntity, accountsRepository],
    [EmailVerificationEntity, verifications],
    [AccountServicePermissionEntity, assignments],
    [SocialIdentityEntity, identities],
  ]);
  const manager = {
    getRepository: jest.fn((target: unknown) => {
      if (!repositories.has(target)) throw new Error('Unexpected repository');
      return repositories.get(target);
    }),
    query: jest.fn().mockResolvedValue(undefined),
  };
  const transactionEvents: string[] = [];
  const dataSource = {
    transaction: jest.fn(
      async (callback: (manager: EntityManager) => Promise<unknown>) => {
        const previousAccount = { ...account };
        const previousVerification = verification ? { ...verification } : null;
        const previousLatest = latest;
        transactionEvents.push('begin');
        try {
          const result = await callback(manager as unknown as EntityManager);
          transactionEvents.push('commit');
          return result;
        } catch (error) {
          Object.assign(account, previousAccount);
          verification = previousVerification;
          latest = previousLatest;
          transactionEvents.push('rollback');
          throw error;
        }
      },
    ),
  };
  const passwords = {
    verify: jest.fn().mockResolvedValue(true),
    hash: jest.fn().mockResolvedValue('new-password-hash'),
  };
  const accounts = {
    revokeAccountSessions: jest.fn().mockResolvedValue(undefined),
  };
  const providers = {
    list: jest.fn().mockReturnValue([
      { key: 'google', label: 'Google' },
      { key: 'kakao', label: 'Kakao' },
    ]),
  };
  const emailDelivery = {
    sendSignupCode: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PortalProfileService(
    dataSource as unknown as DataSource,
    accounts as unknown as AccountsService,
    passwords,
    providers as unknown as SocialProvidersService,
    emailDelivery as unknown as EmailDeliveryService,
    { signupEmailCodePepper: 'test-pepper' } as AppConfigService,
  );
  const start = () => service.startEmailChange(actor, EMAIL_INPUT, '127.0.0.1');
  const complete = (code?: string) =>
    service.completeEmailChange(actor, {
      verificationId: verification!.id,
      code: code ?? (emailDelivery.sendSignupCode.mock.calls[0][1] as string),
    });
  return {
    service,
    account,
    actor,
    accountsRepository,
    verifications,
    assignments,
    identities,
    passwords,
    accounts,
    providers,
    emailDelivery,
    manager,
    transactionEvents,
    start,
    complete,
    get verification() {
      return verification!;
    },
  };
}

function assignment(
  key: string,
  overrides: Partial<AccountServicePermissionEntity> = {},
) {
  return Object.assign(new AccountServicePermissionEntity(), {
    accountId: 'account-id',
    status: 'active',
    revokedAt: null,
    grantedAt: NOW,
    service: Object.assign(new ServiceEntity(), {
      id: `service-${key}`,
      serviceKey: key,
      name: `${key} service`,
      description: `${key} description`,
      status: 'active',
    }),
    permissionDefinition: Object.assign(
      new ServicePermissionDefinitionEntity(),
      {
        key,
        label: `${key} label`,
        status: 'active',
        removedAt: null,
      },
    ),
    ...overrides,
  });
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Portal profile overview', () => {
  it('returns only own active non-visitor services, including assigned deprecated roles', async () => {
    const runtime = setup();
    const deprecated = assignment('legacy');
    deprecated.permissionDefinition.status = 'deprecated';
    const removed = assignment('removed');
    removed.permissionDefinition.status = 'removed';
    const removedAt = assignment('removed-at');
    removedAt.permissionDefinition.removedAt = NOW;
    const disabled = assignment('disabled');
    disabled.service.status = 'disabled';
    const archived = assignment('archived');
    archived.service.status = 'archived';
    runtime.assignments.find.mockResolvedValue([
      assignment('member'),
      deprecated,
      assignment('ViSiToR'),
      assignment('GUEST'),
      assignment('guest'),
      assignment('other', { accountId: 'another-account' }),
      assignment('revoked', { status: 'revoked' }),
      assignment('suspended', { status: 'suspended' }),
      assignment('revoked-at', { revokedAt: NOW }),
      removed,
      removedAt,
      disabled,
      archived,
    ]);
    const overview = await runtime.service.overview(runtime.actor);
    expect(overview.services).toEqual(
      ['member', 'legacy'].map((key) => ({
        id: `service-${key}`,
        key,
        name: `${key} service`,
        description: `${key} description`,
        permission: { key, label: `${key} label` },
        grantedAt: NOW,
      })),
    );
    expect(runtime.assignments.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: runtime.account.id, status: 'active' },
      }),
    );
    expect(overview.account).toMatchObject({
      id: runtime.account.id,
      loginId: 'Existing-ID',
      name: 'Immutable Name',
      hasLocalCredentials: true,
    });
    expect(overview.csrfToken).toBe(runtime.actor.csrfToken);
    expect(JSON.stringify(overview)).not.toMatch(
      /passwordHash|credentialVersion/,
    );
  });

  it('merges configured and disabled linked providers without identity secrets', async () => {
    const runtime = setup({ loginId: null, passwordHash: null });
    const identity = (provider: string, accountId = runtime.account.id) => ({
      provider,
      accountId,
      providerClientId: 'secret-client',
      subject: 'secret-subject',
      createdAt: NOW,
    });
    runtime.identities.find.mockResolvedValue([
      identity('google'),
      identity('naver'),
      { ...identity('google'), createdAt: new Date(NOW.getTime() + 1) },
      identity('foreign-provider', 'other-account'),
    ]);
    const overview = await runtime.service.overview(runtime.actor);
    expect(overview.account.hasLocalCredentials).toBe(false);
    expect(overview.socialProviders).toEqual([
      {
        key: 'google',
        label: 'Google',
        linked: true,
        enabled: true,
        linkedAt: NOW,
      },
      {
        key: 'kakao',
        label: 'Kakao',
        linked: false,
        enabled: true,
        linkedAt: null,
      },
      {
        key: 'naver',
        label: 'Naver',
        linked: true,
        enabled: false,
        linkedAt: NOW,
      },
    ]);
    expect(runtime.identities.find).toHaveBeenCalledWith({
      where: { accountId: runtime.account.id },
      order: { createdAt: 'ASC' },
    });
    expect(JSON.stringify(overview)).not.toMatch(
      /secret|subject|providerClientId/,
    );
  });
});

describe('Portal account lock and actor freshness', () => {
  it.each(['overview', 'email-start', 'email-complete', 'password'])(
    'locks the current row and denies a stale actor for %s',
    async (method) => {
      const runtime = setup();
      runtime.account.credentialVersion += 1;
      const action = () => {
        if (method === 'overview')
          return runtime.service.overview(runtime.actor);
        if (method === 'email-start') return runtime.start();
        if (method === 'email-complete') {
          return runtime.service.completeEmailChange(runtime.actor, {
            verificationId: 'proof-id',
            code: 'ABC234',
          });
        }
        return runtime.service.changePassword(runtime.actor, PASSWORD_INPUT);
      };
      await expect(action()).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({
          code: 'reauthentication_required',
        }),
      });
      expect(runtime.accountsRepository.findOne).toHaveBeenCalledWith({
        where: { id: runtime.account.id },
        lock: { mode: 'pessimistic_write' },
      });
      expect(runtime.accountsRepository.update).not.toHaveBeenCalled();
      expect(runtime.accounts.revokeAccountSessions).not.toHaveBeenCalled();
    },
  );

  it.each(['locked', 'disabled'] as const)(
    'denies %s accounts',
    async (status) => {
      const runtime = setup();
      runtime.account.status = status;
      await expect(runtime.start()).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(
        runtime.service.changePassword(runtime.actor, PASSWORD_INPUT),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(runtime.passwords.verify).not.toHaveBeenCalled();
    },
  );

  it('denies deleted accounts', async () => {
    const runtime = setup();
    runtime.accountsRepository.findOne.mockResolvedValue(null);
    await expect(runtime.start()).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('Portal email verification', () => {
  it('delivers a five-minute hashed, purpose-bound proof without updating the account', async () => {
    const runtime = setup();
    const result = await runtime.start();
    const code = runtime.emailDelivery.sendSignupCode.mock
      .calls[0][1] as string;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(result).toEqual({
      verificationId: runtime.verification.id,
      email: 'new@example.test',
      expiresAt: new Date(NOW.getTime() + 5 * 60_000),
    });
    expect(runtime.verification).toMatchObject({
      email: result.email,
      purpose: 'account_email_change',
      codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      contextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      attemptCount: 0,
      requestIp: '127.0.0.1',
      consumedAt: null,
    });
    expect(JSON.stringify(runtime.verification)).not.toContain(code);
    expect(runtime.emailDelivery.sendSignupCode).toHaveBeenCalledWith(
      result.email,
      code,
      '5 minutes',
    );
    expect(runtime.account.email).toBe('old@example.test');
    expect(runtime.accountsRepository.update).not.toHaveBeenCalled();
  });

  it.each([
    { loginId: null, passwordHash: null },
    { loginId: null, passwordHash: 'hash' },
    { loginId: 'ID', passwordHash: null },
  ])(
    'denies email changes without both real local credentials: %j',
    async (values) => {
      const runtime = setup(values);
      await expect(runtime.start()).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        runtime.service.completeEmailChange(runtime.actor, {
          verificationId: 'proof-id',
          code: 'ABC234',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(runtime.passwords.verify).not.toHaveBeenCalled();
      expect(runtime.emailDelivery.sendSignupCode).not.toHaveBeenCalled();
    },
  );

  it('requires the correct current password regardless of linked social providers', async () => {
    const runtime = setup();
    runtime.passwords.verify.mockResolvedValue(false);
    await expect(runtime.start()).rejects.toBeInstanceOf(UnauthorizedException);
    expect(runtime.verifications.save).not.toHaveBeenCalled();
    expect(runtime.identities.find).not.toHaveBeenCalled();
    expect(runtime.passwords.verify).toHaveBeenCalledWith(
      'current-password-hash',
      EMAIL_INPUT.currentPassword,
    );
  });

  it('rejects unchanged normalized email and another owner', async () => {
    const runtime = setup();
    await expect(
      runtime.service.startEmailChange(
        runtime.actor,
        { ...EMAIL_INPUT, email: ' OLD@EXAMPLE.TEST ' },
        null,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    runtime.accountsRepository.exists.mockResolvedValue(true);
    await expect(runtime.start()).rejects.toBeInstanceOf(ConflictException);
    const where = runtime.accountsRepository.exists.mock.calls[0][0].where as {
      email: FindOperator<string>;
    };
    expect(where.email.type).toBe('raw');
    expect(where.email.getSql?.('email')).toBe(
      'LOWER(BTRIM(email)) = :portalEmail',
    );
    expect(where.email.objectLiteralParameters).toEqual({
      portalEmail: 'new@example.test',
    });
    expect(runtime.emailDelivery.sendSignupCode).not.toHaveBeenCalled();
  });

  it.each([
    'purpose',
    'account',
    'session',
    'version',
    'expired',
    'consumed',
    'missing',
  ])('rejects a %s proof without changing credentials', async (invalid) => {
    const runtime = setup();
    await runtime.start();
    if (invalid === 'purpose') runtime.verification.purpose = 'social';
    if (invalid === 'account') {
      runtime.actor.account.id = 'other-account';
      runtime.account.id = 'other-account';
    }
    if (invalid === 'session')
      runtime.actor.session.tokenHash = 'another-session';
    if (invalid === 'version') {
      runtime.actor.account.credentialVersion += 1;
      runtime.account.credentialVersion += 1;
    }
    if (invalid === 'expired') jest.setSystemTime(NOW.getTime() + 5 * 60_000);
    if (invalid === 'consumed') runtime.verification.consumedAt = NOW;
    if (invalid === 'missing')
      runtime.verifications.findOne.mockResolvedValue(null);
    await expect(runtime.complete()).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(runtime.accountsRepository.update).not.toHaveBeenCalled();
    expect(runtime.verifications.increment).not.toHaveBeenCalled();
  });

  it('commits failed attempts before returning errors and rejects the correct code after five failures', async () => {
    const runtime = setup();
    await runtime.start();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(runtime.complete('000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(runtime.verification.attemptCount).toBe(attempt);
      expect(runtime.transactionEvents.at(-1)).toBe('commit');
    }
    await expect(runtime.complete()).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(runtime.verifications.increment).toHaveBeenCalledTimes(5);
    expect(runtime.accountsRepository.update).not.toHaveBeenCalled();
  });

  it('confirms only the stored email and revokes every session inside the transaction', async () => {
    const runtime = setup();
    await runtime.start();
    expect(await runtime.complete()).toEqual({ reauthenticate: true });
    expect(runtime.accountsRepository.update).toHaveBeenCalledWith(
      runtime.account.id,
      {
        email: 'new@example.test',
        emailVerifiedAt: NOW,
        credentialVersion: 3,
      },
    );
    expect(runtime.verifications.update).toHaveBeenCalledWith(
      runtime.verification.id,
      { consumedAt: NOW },
    );
    expect(runtime.accounts.revokeAccountSessions).toHaveBeenCalledWith(
      runtime.account.id,
      runtime.manager,
    );
    expect(runtime.account).toMatchObject({
      loginId: 'Existing-ID',
      name: 'Immutable Name',
      isSuperAdmin: true,
      passwordHash: 'current-password-hash',
    });
    runtime.actor.account.credentialVersion = runtime.account.credentialVersion;
    await expect(runtime.complete()).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(runtime.accountsRepository.update).toHaveBeenCalledTimes(1);
  });

  it('rechecks email ownership at completion', async () => {
    const runtime = setup();
    await runtime.start();
    runtime.accountsRepository.exists.mockResolvedValue(true);
    await expect(runtime.complete()).rejects.toBeInstanceOf(ConflictException);
    expect(runtime.verification.consumedAt).toBeNull();
    expect(runtime.accountsRepository.update).not.toHaveBeenCalled();
  });

  it('rolls back email, credential version and proof consumption if revocation fails', async () => {
    const runtime = setup();
    await runtime.start();
    runtime.accounts.revokeAccountSessions.mockRejectedValue(
      new Error('revoke failed'),
    );
    await expect(runtime.complete()).rejects.toThrow('revoke failed');
    expect(runtime.account.email).toBe('old@example.test');
    expect(runtime.account.credentialVersion).toBe(2);
    expect(runtime.verification.consumedAt).toBeNull();
    expect(runtime.transactionEvents.at(-1)).toBe('rollback');
  });

  it('enforces the 60-second resend cooldown and accepts the exact boundary', async () => {
    const runtime = setup();
    await runtime.start();
    jest.setSystemTime(NOW.getTime() + 59_999);
    await expect(runtime.start()).rejects.toThrow('Wait 60 seconds');
    jest.setSystemTime(NOW.getTime() + 60_000);
    await expect(runtime.start()).resolves.toMatchObject({
      email: 'new@example.test',
    });
    expect(runtime.emailDelivery.sendSignupCode).toHaveBeenCalledTimes(2);
  });

  it.each([
    { counts: [5], message: 'for this email' },
    { counts: [4, 10], message: 'from this IP' },
  ])(
    'counts all verification purposes and enforces quota: %j',
    async ({ counts, message }) => {
      const runtime = setup();
      for (const count of counts)
        runtime.verifications.countBy.mockResolvedValueOnce(count);
      await expect(runtime.start()).rejects.toThrow(message);
      expect(runtime.verifications.save).not.toHaveBeenCalled();
      expect(runtime.verifications.countBy).toHaveBeenNthCalledWith(1, {
        email: 'new@example.test',
        createdAt: expect.objectContaining({
          _type: 'moreThan',
          _value: new Date(NOW.getTime() - 30 * 60_000),
        }),
      });
      if (counts.length === 2) {
        expect(runtime.verifications.countBy).toHaveBeenNthCalledWith(2, {
          requestIp: '127.0.0.1',
          createdAt: expect.objectContaining({
            _type: 'moreThan',
            _value: new Date(NOW.getTime() - 60 * 60_000),
          }),
        });
      }
      expect(runtime.manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        ['social-email:new@example.test'],
      );
      expect(runtime.manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        ['social-email-ip:127.0.0.1'],
      );
    },
  );

  it('skips only the IP quota when no IP is available', async () => {
    const runtime = setup();
    await runtime.service.startEmailChange(runtime.actor, EMAIL_INPUT, null);
    expect(runtime.verifications.countBy).toHaveBeenCalledTimes(1);
  });

  it('propagates delivery failure without changing the account or exposing a code', async () => {
    const runtime = setup();
    runtime.emailDelivery.sendSignupCode.mockRejectedValue(
      new Error('SMTP unavailable'),
    );
    await expect(runtime.start()).rejects.toThrow('SMTP unavailable');
    expect(runtime.account.email).toBe('old@example.test');
    expect(runtime.accountsRepository.update).not.toHaveBeenCalled();
  });
});

describe('Portal password change and local ID registration', () => {
  it('changes only password fields and version, retaining the immutable ID and name', async () => {
    const runtime = setup();
    expect(
      await runtime.service.changePassword(runtime.actor, PASSWORD_INPUT),
    ).toEqual({ reauthenticate: true });
    expect(runtime.passwords.verify).toHaveBeenCalledWith(
      'current-password-hash',
      PASSWORD_INPUT.currentPassword,
    );
    expect(runtime.accountsRepository.update).toHaveBeenCalledWith(
      runtime.account.id,
      {
        passwordHash: 'new-password-hash',
        passwordResetRequired: false,
        credentialVersion: 3,
      },
    );
    expect(runtime.account.name).toBe('Immutable Name');
    expect(runtime.account.loginId).toBe('Existing-ID');
    expect(runtime.account.email).toBe('old@example.test');
    expect(runtime.accounts.revokeAccountSessions).toHaveBeenCalledWith(
      runtime.account.id,
      runtime.manager,
    );
    expect(runtime.manager.getRepository).not.toHaveBeenCalledWith(
      AccountServicePermissionEntity,
    );
  });

  it.each(['different', '', 'existing-id'])(
    'rejects changing an existing login ID to %j',
    async (loginId) => {
      const runtime = setup();
      await expect(
        runtime.service.changePassword(runtime.actor, {
          ...PASSWORD_INPUT,
          loginId,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runtime.accountsRepository.update).not.toHaveBeenCalled();
    },
  );

  it('accepts the same login ID but does not write it back', async () => {
    const runtime = setup();
    await runtime.service.changePassword(runtime.actor, {
      ...PASSWORD_INPUT,
      loginId: ' Existing-ID ',
    });
    expect(
      runtime.accountsRepository.update.mock.calls[0][1],
    ).not.toHaveProperty('loginId');
  });

  it.each([undefined, '', 'incorrect!password'])(
    'requires the existing local password: %j',
    async (currentPassword) => {
      const runtime = setup();
      runtime.passwords.verify.mockResolvedValue(false);
      await expect(
        runtime.service.changePassword(runtime.actor, {
          ...PASSWORD_INPUT,
          currentPassword,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(runtime.passwords.hash).not.toHaveBeenCalled();
    },
  );

  it.each([
    { password: 'short!', passwordConfirm: 'short!' },
    { password: 'noSpecialCharacter', passwordConfirm: 'noSpecialCharacter' },
    { password: '123456789', passwordConfirm: '123456789' },
    { password: 'Password!1', passwordConfirm: 'Password!2' },
  ])(
    'validates the normal password policy and matching pair: %j',
    async (input) => {
      const runtime = setup();
      await expect(
        runtime.service.changePassword(runtime.actor, {
          ...PASSWORD_INPUT,
          ...input,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runtime.passwords.hash).not.toHaveBeenCalled();
      expect(runtime.accountsRepository.update).not.toHaveBeenCalled();
    },
  );

  it('registers the first local ID/password for a recently authenticated social-only account', async () => {
    const runtime = setup({ loginId: null, passwordHash: null });
    const password = ' Password!1 ';
    expect(
      await runtime.service.changePassword(runtime.actor, {
        loginId: ' New-ID ',
        password,
        passwordConfirm: password,
      }),
    ).toEqual({ reauthenticate: true });
    expect(runtime.passwords.verify).not.toHaveBeenCalled();
    expect(runtime.passwords.hash).toHaveBeenCalledWith(password);
    expect(runtime.accountsRepository.findOneBy).toHaveBeenCalledWith({
      loginId: 'New-ID',
    });
    expect(runtime.accountsRepository.update).toHaveBeenCalledWith(
      runtime.account.id,
      {
        loginId: 'New-ID',
        passwordHash: 'new-password-hash',
        passwordResetRequired: false,
        credentialVersion: 3,
      },
    );
    expect(runtime.account.name).toBe('Immutable Name');
    expect(runtime.accounts.revokeAccountSessions).toHaveBeenCalledWith(
      runtime.account.id,
      runtime.manager,
    );
  });

  it.each([undefined, '', '  '])(
    'requires an ID for social-only registration: %j',
    async (loginId) => {
      const runtime = setup({ loginId: null, passwordHash: null });
      await expect(
        runtime.service.changePassword(runtime.actor, {
          ...PASSWORD_INPUT,
          loginId,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runtime.passwords.hash).not.toHaveBeenCalled();
    },
  );

  it('returns 409 for an already-owned login ID', async () => {
    const runtime = setup({ loginId: null, passwordHash: null });
    runtime.accountsRepository.findOneBy.mockResolvedValue({
      id: 'another-account',
    });
    await expect(
      runtime.service.changePassword(runtime.actor, {
        ...PASSWORD_INPUT,
        loginId: 'taken',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(runtime.accountsRepository.update).not.toHaveBeenCalled();
  });

  it.each(['email', 'password'])(
    'maps unique-index races to 409 for %s changes',
    async (change) => {
      const runtime = setup();
      await runtime.start();
      runtime.accountsRepository.update.mockRejectedValue(
        new QueryFailedError(
          'UPDATE accounts',
          [],
          Object.assign(new Error('duplicate'), { code: '23505' }),
        ),
      );
      await expect(
        change === 'email'
          ? runtime.complete()
          : runtime.service.changePassword(runtime.actor, PASSWORD_INPUT),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(runtime.accounts.revokeAccountSessions).not.toHaveBeenCalled();
    },
  );

  it.each([
    'stale',
    'future',
    'invalid',
    'null',
    'non-ISO',
    'stale-with-recent-createdAt',
  ])(
    'requires reauthentication for %s authentication metadata',
    async (metadata) => {
      const runtime = setup({ loginId: null, passwordHash: null });
      const values: Record<string, unknown> = {
        stale: new Date(NOW.getTime() - RECENT_AUTH_MS - 1).toISOString(),
        future: new Date(NOW.getTime() + 1).toISOString(),
        invalid: 'invalid-date',
        null: null,
        'non-ISO': 'November 16 2026 05:00:00 GMT',
        'stale-with-recent-createdAt': new Date(
          NOW.getTime() - RECENT_AUTH_MS - 1,
        ).toISOString(),
      };
      runtime.actor.session.metadataJson = {
        authenticatedAt: values[metadata],
      };
      const error = await runtime.service
        .changePassword(runtime.actor, { ...PASSWORD_INPUT, loginId: 'New-ID' })
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(403);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: 'reauthentication_required',
      });
      expect(runtime.passwords.hash).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'uses session createdAt only when authenticatedAt is absent (recent=%s)',
    async (recent) => {
      const runtime = setup({ loginId: null, passwordHash: null });
      runtime.actor.session.metadataJson = null;
      runtime.actor.session.createdAt = new Date(
        NOW.getTime() - RECENT_AUTH_MS - (recent ? 0 : 1),
      );
      const result = runtime.service.changePassword(runtime.actor, {
        ...PASSWORD_INPUT,
        loginId: 'New-ID',
      });
      if (recent)
        await expect(result).resolves.toEqual({ reauthenticate: true });
      else await expect(result).rejects.toMatchObject({ status: 403 });
    },
  );

  it('rolls back credential changes when revocation fails', async () => {
    const runtime = setup({ loginId: null, passwordHash: null });
    runtime.accounts.revokeAccountSessions.mockRejectedValue(
      new Error('revoke failed'),
    );
    await expect(
      runtime.service.changePassword(runtime.actor, {
        ...PASSWORD_INPUT,
        loginId: 'New-ID',
      }),
    ).rejects.toThrow('revoke failed');
    expect(runtime.account).toMatchObject({
      loginId: null,
      passwordHash: null,
      credentialVersion: 2,
      name: 'Immutable Name',
    });
    expect(runtime.transactionEvents.at(-1)).toBe('rollback');
  });
});
