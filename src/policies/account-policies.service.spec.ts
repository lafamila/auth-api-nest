import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AccountPolicyConsentEntity } from '../database/entities/account-policy-consent.entity';
import { AccountEntity } from '../database/entities/account.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { PortalActor } from '../portal/portal.types';
import { PublicSiteService } from '../public-site/public-site.service';
import { AccountPoliciesService } from './account-policies.service';
import { PolicyAcceptanceDto } from './policy-acceptance.dto';

function setup() {
  const settings: Record<string, string> = {};
  const site = new PublicSiteService(new ConfigService(settings));
  const consents = { findOneBy: jest.fn().mockResolvedValue(null) };
  const insert = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  const account = Object.assign(new AccountEntity(), {
    id: 'account-id',
    status: 'active',
    credentialVersion: 4,
    passwordResetRequired: false,
  });
  const session = Object.assign(new TokenRecordEntity(), {
    id: 'session-id',
    accountId: account.id,
    type: 'portal_session',
    status: 'active',
    expiresAt: new Date(Date.now() + 60_000),
  });
  const actor: PortalActor = { account, session, csrfToken: 'csrf' };
  const manager = {
    getRepository: jest.fn(() => ({ createQueryBuilder: () => insert })),
    findOne: jest.fn(
      async (
        target: unknown,
      ): Promise<AccountEntity | TokenRecordEntity | null> =>
        target === AccountEntity ? account : session,
    ),
  };
  const dataSource = {
    transaction: jest.fn(
      async (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback(manager as unknown as EntityManager),
    ),
  };
  const subject = new AccountPoliciesService(
    dataSource as unknown as DataSource,
    consents as unknown as Repository<AccountPolicyConsentEntity>,
    site,
  );
  const { termsVersion, privacyVersion, policyDigest } = subject.current();
  const input: PolicyAcceptanceDto = {
    termsAccepted: true,
    privacyAccepted: true,
    termsVersion,
    privacyVersion,
    policyDigest,
  };
  return {
    subject,
    settings,
    site,
    consents,
    insert,
    manager,
    dataSource,
    actor,
    input,
  };
}

describe('AccountPoliciesService', () => {
  it('publishes deterministic current metadata and changes its digest when public facts change', () => {
    const { subject, settings } = setup();
    const current = subject.current();
    expect(current).toEqual({
      termsVersion: '2026-11-18',
      privacyVersion: '2026-11-18',
      policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      termsUrl: '/terms',
      privacyUrl: '/privacy',
    });
    expect(subject.current()).toEqual(current);
    settings.AUTH_PUBLIC_SUPPORT_EMAIL = 'changed@example.test';
    expect(subject.current().policyDigest).not.toBe(current.policyDigest);
  });

  it('accepts only explicit current agreement', () => {
    const { subject, input } = setup();
    expect(() => subject.validate(input)).not.toThrow();
  });

  it('does not reuse an agreement digest after the displayed policy text changes', () => {
    const { subject, site, input } = setup();
    const render: PublicSiteService['render'] = site.render.bind(
      site,
    ) as PublicSiteService['render'];
    jest
      .spyOn(site, 'render')
      .mockImplementation(
        (page) => `${render(page)}<!-- policy correction -->`,
      );
    expect(subject.current().policyDigest).not.toBe(input.policyDigest);
    expect(() => subject.validate(input)).toThrow(BadRequestException);
  });

  it.each([
    {},
    { termsAccepted: false },
    { privacyAccepted: false },
    { termsAccepted: 'true' },
    { privacyAccepted: 1 },
    { termsVersion: 'old' },
    { privacyVersion: 'old' },
    { policyDigest: '0'.repeat(64) },
  ])('rejects missing, implicit or stale agreement %j', (override) => {
    const { subject, input } = setup();
    const invalid = Object.keys(override).length
      ? { ...input, ...override }
      : {};
    expect(() => subject.validate(invalid as PolicyAcceptanceDto)).toThrow(
      BadRequestException,
    );
  });

  it('rejects old metadata even when the version strings have not changed', () => {
    const { subject, settings, input } = setup();
    settings.AUTH_PUBLIC_SUPPORT_EMAIL = 'changed@example.test';
    expect(() => subject.validate(input)).toThrow(BadRequestException);
  });

  it('records exactly the account, versions, digest and source using the caller transaction', async () => {
    const { subject, input, manager, insert, dataSource } = setup();
    await subject.record(
      manager as unknown as EntityManager,
      'new-account',
      input,
      'signup',
    );
    expect(manager.getRepository).toHaveBeenCalledWith(
      AccountPolicyConsentEntity,
    );
    expect(insert.values).toHaveBeenCalledWith({
      accountId: 'new-account',
      termsVersion: input.termsVersion,
      privacyVersion: input.privacyVersion,
      policyDigest: input.policyDigest,
      source: 'signup',
    });
    expect(insert.orIgnore).toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('revalidates immediately before recording and never writes stale consent', async () => {
    const { subject, input, settings, manager, insert } = setup();
    settings.AUTH_PUBLIC_SUPPORT_EMAIL = 'changed@example.test';
    await expect(
      subject.record(
        manager as unknown as EntityManager,
        'account',
        input,
        'social_signup',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(insert.execute).not.toHaveBeenCalled();
  });

  it('does not backfill existing accounts while reading policy status', async () => {
    const { subject, actor, consents, manager, dataSource, input } = setup();
    await expect(subject.status(actor)).resolves.toMatchObject({
      accepted: false,
      acceptedAt: null,
    });
    expect(consents.findOneBy).toHaveBeenCalledWith({
      accountId: actor.account.id,
      termsVersion: input.termsVersion,
      privacyVersion: input.privacyVersion,
      policyDigest: input.policyDigest,
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(manager.getRepository).not.toHaveBeenCalled();
    const acceptedAt = new Date();
    consents.findOneBy.mockResolvedValueOnce({ acceptedAt });
    await expect(subject.status(actor)).resolves.toMatchObject({
      accepted: true,
      acceptedAt,
    });
  });

  it('locks the current account and matching live portal session before accepting', async () => {
    const { subject, actor, input, manager, insert } = setup();
    await subject.accept(actor, input);
    expect(manager.findOne).toHaveBeenCalledWith(AccountEntity, {
      where: { id: actor.account.id },
      lock: { mode: 'pessimistic_write' },
    });
    expect(manager.findOne).toHaveBeenCalledWith(TokenRecordEntity, {
      where: {
        id: actor.session.id,
        accountId: actor.account.id,
        type: 'portal_session',
        status: 'active',
      },
      lock: { mode: 'pessimistic_write' },
    });
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: actor.account.id,
        source: 'portal',
      }),
    );
  });

  it.each([
    'missing-account',
    'disabled',
    'reset',
    'credentials',
    'missing-session',
    'expired-session',
  ])('fails closed on a concurrent %s change', async (change) => {
    const { subject, actor, input, manager, insert } = setup();
    const account = { ...actor.account };
    const session = { ...actor.session };
    if (change === 'disabled') account.status = 'disabled';
    if (change === 'reset') account.passwordResetRequired = true;
    if (change === 'credentials') account.credentialVersion += 1;
    if (change === 'expired-session') session.expiresAt = new Date(0);
    manager.findOne.mockImplementation(async (target: unknown) =>
      target === AccountEntity
        ? change === 'missing-account'
          ? null
          : account
        : change === 'missing-session'
          ? null
          : session,
    );
    await expect(subject.accept(actor, input)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(insert.execute).not.toHaveBeenCalled();
  });
});
