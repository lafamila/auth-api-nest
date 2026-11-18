import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import { hashToken } from '../common/crypto/token-hash';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { SocialIdentityEntity } from '../database/entities/social-identity.entity';
import { SocialLoginTransactionEntity } from '../database/entities/social-login-transaction.entity';
import { AccountsService } from '../domain/accounts/accounts.service';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';
import { AuthorizeFlowService } from '../oidc/authorize-flow.service';
import { HostedLoginTransactionService } from '../oidc/hosted-login-transaction.service';
import { EmailDeliveryService } from '../signup/email-delivery.service';
import { SocialLoginService } from './social-login.service';
import { SocialProvidersService } from './social-providers.service';
import { AccountPoliciesService } from '../policies/account-policies.service';
import { ProviderRevocationsService } from './provider-revocations.service';
import { AccountPolicyConsentEntity } from '../database/entities/account-policy-consent.entity';
import { PublicSiteService } from '../public-site/public-site.service';

const state = 'social-transaction';
const context = { binding: 'browser-binding', sessionAccountId: null };
const site = new PublicSiteService(new ConfigService());
const realPolicies = new AccountPoliciesService(
  {} as DataSource,
  {} as Repository<AccountPolicyConsentEntity>,
  site,
);
const { termsVersion, privacyVersion, policyDigest } = realPolicies.current();
const signupInput = {
  email: 'social@example.test',
  name: 'Social User',
  termsAccepted: true as const,
  privacyAccepted: true as const,
  termsVersion,
  privacyVersion,
  policyDigest,
};

function setup(provider = 'google') {
  const row: SocialLoginTransactionEntity = Object.assign(
    new SocialLoginTransactionEntity(),
    {
      id: 'transaction-id',
      tokenHash: hashToken(state),
      browserBindingHash: hashToken(context.binding),
      provider,
      phase: 'signup',
      expiresAt: new Date(Date.now() + 60_000),
      data: {
        request: null,
        purpose: 'portal',
        sessionAccountId: null,
        providerClientId: `${provider}-client`,
        profile: {
          provider,
          providerClientId: `${provider}-client`,
          subject: 'provider-subject',
          ...signupInput,
          emailVerified: provider !== 'naver',
        },
        email: signupInput.email,
        emailVerified: true,
      },
    },
  );
  const account = Object.assign(new AccountEntity(), {
    id: 'account-id',
    ...signupInput,
    loginId: null,
    passwordHash: null,
    status: 'active',
    passwordResetRequired: false,
    credentialVersion: 0,
  });
  const transactions = { findOne: jest.fn().mockResolvedValue(row) };
  const identities = {
    findOneBy: jest.fn().mockResolvedValue(null),
    create: jest.fn((value: Partial<SocialIdentityEntity>) => value),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const query = {
    where: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const manager = {
    getRepository: jest.fn((target: unknown) => {
      if (target === SocialLoginTransactionEntity) return transactions;
      if (target === SocialIdentityEntity) return identities;
      if (target === AccountEntity) return { createQueryBuilder: () => query };
      throw new Error('Unexpected repository');
    }),
    query: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    save: jest.fn(async (value: unknown) => value),
    update: jest.fn().mockResolvedValue(undefined),
    findOneOrFail: jest.fn().mockResolvedValue(account),
    findOne: jest.fn().mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      metadataJson: {
        authenticatedAt: new Date().toISOString(),
        credentialVersion: 0,
      },
    }),
  };
  const dataSource = {
    transaction: jest.fn(
      async (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback(manager as unknown as EntityManager),
    ),
  };
  const accounts = {
    createSocialAccount: jest.fn().mockResolvedValue(account),
  };
  const providers = {
    clientIdFor: jest.fn().mockReturnValue(`${provider}-client`),
    exchangeCode: jest.fn().mockResolvedValue(row.data.profile),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const policies = new AccountPoliciesService(
    dataSource as unknown as DataSource,
    {} as Repository<AccountPolicyConsentEntity>,
    site,
  );
  const record = jest.spyOn(policies, 'record').mockResolvedValue(undefined);
  const revocations = {
    assertConnectionAvailable: jest.fn().mockResolvedValue(undefined),
    mergeGrant: jest.fn().mockReturnValue('merged-encrypted-grant'),
  };
  const subject = new SocialLoginService(
    dataSource as unknown as DataSource,
    transactions as unknown as Repository<SocialLoginTransactionEntity>,
    providers as unknown as SocialProvidersService,
    {} as HostedLoginTransactionService,
    {} as AuthorizeFlowService,
    accounts as unknown as AccountsService,
    {
      decrypt: jest.fn().mockReturnValue('pkce-verifier'),
    } as unknown as AesGcmService,
    audit as unknown as AuditLogsService,
    {} as EmailDeliveryService,
    {} as AppConfigService,
    policies,
    revocations as unknown as ProviderRevocationsService,
  );
  return {
    subject,
    row,
    account,
    manager,
    dataSource,
    accounts,
    identities,
    policies,
    record,
    revocations,
    providers,
  };
}

describe('Social signup credential separation', () => {
  it('checks the target fence before creating an identity or consuming the social transaction', async () => {
    const { subject, revocations, accounts, identities, manager, row } =
      setup();
    revocations.assertConnectionAvailable.mockRejectedValueOnce(
      new ConflictException({ code: 'provider_connection_pending' }),
    );
    await expect(
      subject.complete(state, context, signupInput),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'provider_connection_pending',
      }),
    });
    expect(revocations.assertConnectionAvailable).toHaveBeenCalledWith(
      manager,
      row.data.profile,
    );
    expect(accounts.createSocialAccount).not.toHaveBeenCalled();
    expect(identities.save).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
    await expect(
      subject.complete(state, context, signupInput),
    ).resolves.toMatchObject({ kind: 'authenticated' });
  });

  it.each(['new-link', 'existing-grant'])(
    'blocks pending revocation before %s mutations in an explicit linking callback',
    async (scenario) => {
      const f = setup();
      f.row.phase = 'authorization';
      f.row.data.purpose = 'link';
      f.row.data.targetAccountId = f.account.id;
      f.row.data.portalSessionHash = 'portal-session-hash';
      f.row.data.credentialVersion = 0;
      f.row.data.encryptedVerifier = 'encrypted-verifier';
      f.row.data.profile!.encryptedRevocationGrant = 'fresh-proof';
      if (scenario === 'existing-grant')
        f.identities.findOneBy.mockResolvedValue({
          id: 'old-identity',
          accountId: f.account.id,
          encryptedRevocationGrant: 'old-proof',
        });
      f.revocations.assertConnectionAvailable.mockRejectedValueOnce(
        new ConflictException({ code: 'provider_connection_pending' }),
      );
      await expect(
        f.subject.callback(
          'google',
          state,
          { ...context, portalSessionHash: 'portal-session-hash' },
          'provider-code',
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'provider_connection_pending',
        }),
      });
      expect(f.revocations.assertConnectionAvailable).toHaveBeenCalledWith(
        f.manager,
        f.row.data.profile,
      );
      expect(f.identities.save).not.toHaveBeenCalled();
      expect(f.identities.update).not.toHaveBeenCalled();
      expect(f.revocations.mergeGrant).not.toHaveBeenCalled();
      expect(f.manager.delete).not.toHaveBeenCalled();
      expect(f.manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        ['auth:last-active-superadmin'],
      );
    },
  );

  it('blocks grant refresh in a normal social login when an older disconnect remains active', async () => {
    const f = setup();
    f.row.phase = 'authorization';
    f.row.data.encryptedVerifier = 'encrypted-verifier';
    f.row.data.profile!.encryptedRevocationGrant = 'fresh-proof';
    f.identities.findOneBy.mockResolvedValue({
      id: 'old-identity',
      accountId: f.account.id,
      encryptedRevocationGrant: 'old-proof',
    });
    f.revocations.assertConnectionAvailable.mockRejectedValueOnce(
      new ConflictException({ code: 'provider_connection_pending' }),
    );
    await expect(
      f.subject.callback('google', state, context, 'provider-code'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'provider_connection_pending',
      }),
    });
    expect(f.identities.update).not.toHaveBeenCalled();
    expect(f.manager.update).not.toHaveBeenCalled();
    expect(f.revocations.mergeGrant).not.toHaveBeenCalled();
    expect(f.manager.delete).not.toHaveBeenCalled();
  });
  it.each([
    { termsAccepted: false },
    { privacyAccepted: false },
    { termsAccepted: undefined },
    { privacyAccepted: undefined },
    { termsVersion: 'old' },
    { privacyVersion: 'old' },
    { policyDigest: '0'.repeat(64) },
  ])(
    'rejects invalid server policy agreement without consuming the transaction %j',
    async (extra) => {
      const { subject, accounts, manager, dataSource, record } = setup();
      await expect(
        subject.complete(state, context, {
          ...signupInput,
          ...extra,
        } as typeof signupInput),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(accounts.createSocialAccount).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
    },
  );

  it('returns current policy metadata bound to the browser signup page', async () => {
    const { subject, policies } = setup();
    await expect(subject.signupPage(state, context)).resolves.toEqual({
      transaction: state,
      policy: policies.current(),
      email: signupInput.email,
      emailVerified: true,
      name: signupInput.name,
    });
    await expect(
      subject.signupPage(state, { ...context, binding: 'wrong-browser' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('leaves the social transaction unconsumed if recording agreement fails', async () => {
    const { subject, record, manager } = setup();
    record.mockRejectedValueOnce(new Error('Consent insert failed'));
    await expect(subject.complete(state, context, signupInput)).rejects.toThrow(
      'Consent insert failed',
    );
    expect(manager.delete).not.toHaveBeenCalled();
  });
  it.each(['loginId', 'password', 'passwordConfirm'])(
    'rejects the literal %s field even when the DTO is bypassed',
    async (field) => {
      const { subject, dataSource, accounts } = setup();
      for (const value of [
        'Local-password!1',
        '',
        '  ',
        null,
        undefined,
        0,
        false,
        [],
      ]) {
        await expect(
          subject.complete(state, context, { ...signupInput, [field]: value }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(accounts.createSocialAccount).not.toHaveBeenCalled();
    },
  );

  it('rejects matching credentials without consuming the signup and permits a social-only retry', async () => {
    const { subject, manager, accounts } = setup();
    const input = {
      ...signupInput,
      loginId: 'local-user',
      password: 'Local-password!1',
      passwordConfirm: 'Local-password!1',
    };
    await expect(
      subject.complete(state, context, input),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.delete).not.toHaveBeenCalled();
    expect(accounts.createSocialAccount).not.toHaveBeenCalled();
    await expect(
      subject.complete(state, context, signupInput),
    ).resolves.toMatchObject({
      account: { loginId: null, passwordHash: null },
    });
  });

  it.each(['google', 'kakao', 'naver'])(
    'creates a social-only %s account without forwarding credentials',
    async (provider) => {
      const { subject, account, accounts, manager, identities, record } =
        setup(provider);
      await expect(
        subject.complete(state, context, signupInput),
      ).resolves.toEqual({
        kind: 'authenticated',
        account,
        request: null,
        purpose: 'portal',
        authenticationMethod: provider,
      });
      expect(accounts.createSocialAccount).toHaveBeenCalledWith(
        { email: signupInput.email, name: signupInput.name },
        manager,
      );
      expect(accounts.createSocialAccount.mock.calls[0][0]).toStrictEqual({
        email: signupInput.email,
        name: signupInput.name,
      });
      expect(identities.create).toHaveBeenCalledWith({
        accountId: account.id,
        provider,
        providerClientId: `${provider}-client`,
        subject: 'provider-subject',
      });
      expect(manager.delete).toHaveBeenCalledWith(
        SocialLoginTransactionEntity,
        'transaction-id',
      );
      expect(record).toHaveBeenCalledWith(
        manager,
        account.id,
        signupInput,
        'social_signup',
      );
      expect(record.mock.invocationCallOrder[0]).toBeLessThan(
        manager.delete.mock.invocationCallOrder[0],
      );
    },
  );

  it('still requires verified email before account creation', async () => {
    const { subject, row, accounts, manager } = setup('naver');
    row.data.emailVerified = false;
    await expect(
      subject.complete(state, context, signupInput),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(accounts.createSocialAccount).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it.each(['expired', 'phase', 'browser', 'session', 'provider'])(
    'still rejects a mismatched %s transaction without creating an account',
    async (mismatch) => {
      const { subject, row, accounts, manager } = setup();
      if (mismatch === 'expired') row.expiresAt = new Date(Date.now() - 1);
      if (mismatch === 'phase') row.phase = 'authorization';
      if (mismatch === 'browser')
        row.browserBindingHash = hashToken('another-browser');
      if (mismatch === 'session') row.data.sessionAccountId = 'another-account';
      if (mismatch === 'provider') row.data.providerClientId = 'another-client';

      await expect(
        subject.complete(state, context, signupInput),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(accounts.createSocialAccount).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
    },
  );

  it('preserves the canonical OIDC state, nonce, PKCE and account-selection request', async () => {
    const { subject, row } = setup();
    delete row.data.purpose;
    row.data.request = {
      clientId: 'service-client',
      redirectUri: 'https://service.example.test/callback',
      responseType: 'code',
      scope: 'openid profile email',
      state: 'service-state',
      nonce: 'service-nonce',
      codeChallenge: 'service-pkce-challenge',
      codeChallengeMethod: 'S256',
      prompt: 'select_account',
    };

    const result = await subject.complete(state, context, signupInput);

    expect(result.request).toStrictEqual(row.data.request);
    expect(result).not.toHaveProperty('purpose');
  });
});
