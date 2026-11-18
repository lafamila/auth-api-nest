import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';
import { AccountPolicyConsentEntity } from '../database/entities/account-policy-consent.entity';
import { EmailVerificationEntity } from '../database/entities/email-verification.entity';
import { AccountsService } from '../domain/accounts/accounts.service';
import { AccountPoliciesService } from '../policies/account-policies.service';
import { PolicyAcceptanceDto } from '../policies/policy-acceptance.dto';
import { PublicSiteService } from '../public-site/public-site.service';
import { EmailDeliveryService } from './email-delivery.service';
import { SignupService } from './signup.service';

function setup() {
  const site = new PublicSiteService(new ConfigService());
  const policies = new AccountPoliciesService(
    {} as DataSource,
    {} as Repository<AccountPolicyConsentEntity>,
    site,
  );
  const { termsVersion, privacyVersion, policyDigest } = policies.current();
  const input = {
    loginId: ' new-user ',
    name: ' New User ',
    email: ' NEW@example.test ',
    code: 'ABC123',
    password: 'Password!123',
    termsAccepted: true as const,
    privacyAccepted: true as const,
    termsVersion,
    privacyVersion,
    policyDigest,
  };
  const proof: EmailVerificationEntity = Object.assign(
    new EmailVerificationEntity(),
    {
      id: 'proof-id',
      email: 'new@example.test',
      codeHash: createHash('sha256')
        .update('new@example.test:ABC123:test-pepper')
        .digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      attemptCount: 0,
    },
  );
  const verifications = {
    findOne: jest.fn().mockResolvedValue(proof),
    save: jest.fn(),
  };
  const proofs = {
    findOne: jest.fn().mockResolvedValue(proof),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const manager = { getRepository: jest.fn(() => proofs) };
  const dataSource = {
    transaction: jest.fn(
      async (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback(manager as unknown as EntityManager),
    ),
  };
  const created = {
    id: 'new-account',
    loginId: 'new-user',
    name: 'New User',
    email: 'new@example.test',
  };
  const accounts = {
    findByLoginId: jest.fn().mockResolvedValue(null),
    findByEmail: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(created),
    safeAccount: jest.fn().mockReturnValue(created),
  };
  const record = jest.spyOn(policies, 'record').mockResolvedValue(undefined);
  const subject = new SignupService(
    verifications as unknown as Repository<EmailVerificationEntity>,
    accounts as unknown as AccountsService,
    { signupEmailCodePepper: 'test-pepper' } as AppConfigService,
    {} as EmailDeliveryService,
    dataSource as unknown as DataSource,
    policies,
  );
  return {
    subject,
    input,
    policies,
    record,
    proof,
    verifications,
    proofs,
    manager,
    dataSource,
    accounts,
    created,
  };
}

describe('SignupService consent transaction', () => {
  it.each([
    { termsAccepted: false },
    { privacyAccepted: false },
    { termsVersion: 'old' },
    { privacyVersion: 'old' },
    { policyDigest: '0'.repeat(64) },
    { termsAccepted: undefined },
  ])(
    'rejects invalid agreement before examining or consuming OTP %j',
    async (override) => {
      const { subject, input, verifications, accounts, dataSource } = setup();
      await expect(
        subject.complete({ ...input, ...override } as typeof input),
      ).rejects.toThrow(BadRequestException);
      expect(verifications.findOne).not.toHaveBeenCalled();
      expect(accounts.create).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    },
  );

  it('creates the exact account and consent with the same manager before consuming OTP', async () => {
    const { subject, input, manager, proofs, accounts, record, created } =
      setup();
    await expect(subject.complete(input)).resolves.toEqual({
      account: created,
    });
    expect(manager.getRepository).toHaveBeenCalledWith(EmailVerificationEntity);
    expect(proofs.findOne).toHaveBeenCalledWith({
      where: { id: 'proof-id' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(accounts.create).toHaveBeenCalledWith(
      {
        loginId: 'new-user',
        name: 'New User',
        email: 'new@example.test',
        password: input.password,
        isSuperAdmin: false,
      },
      null,
      { emailVerifiedAt: expect.any(Date), passwordResetRequired: false },
      manager,
    );
    expect(record).toHaveBeenCalledWith(manager, created.id, input, 'signup');
    expect(proofs.update).toHaveBeenCalledWith('proof-id', {
      consumedAt: expect.any(Date),
    });
    expect(accounts.create.mock.invocationCallOrder[0]).toBeLessThan(
      record.mock.invocationCallOrder[0],
    );
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(
      proofs.update.mock.invocationCallOrder[0],
    );
  });

  it('propagates consent persistence failure from the account transaction without consuming OTP', async () => {
    const { subject, input, record, proofs, dataSource, accounts } = setup();
    const failure = new Error('Consent insert failed');
    record.mockRejectedValueOnce(failure);
    await expect(subject.complete(input)).rejects.toBe(failure);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(accounts.create).toHaveBeenCalledTimes(1);
    expect(proofs.update).not.toHaveBeenCalled();
    expect(accounts.safeAccount).not.toHaveBeenCalled();
  });

  it.each(['consumed', 'expired', 'changed-code', 'missing'])(
    'rechecks a %s OTP after acquiring the transaction lock',
    async (change) => {
      const { subject, input, proof, proofs, accounts, record } = setup();
      const current = { ...proof };
      if (change === 'consumed') current.consumedAt = new Date();
      if (change === 'expired') current.expiresAt = new Date(0);
      if (change === 'changed-code') current.codeHash = 'other';
      proofs.findOne.mockResolvedValueOnce(
        change === 'missing' ? null : current,
      );
      await expect(subject.complete(input)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(accounts.create).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(proofs.update).not.toHaveBeenCalled();
    },
  );

  it('uses the real validator rather than accepting truthy booleans', async () => {
    const { subject, input } = setup();
    const invalid = {
      ...input,
      termsAccepted: 'true',
    } as unknown as typeof input & PolicyAcceptanceDto;
    await expect(subject.complete(invalid)).rejects.toThrow(
      BadRequestException,
    );
  });
});
