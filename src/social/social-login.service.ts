import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isEmail } from 'class-validator';
import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import {
  DataSource,
  EntityManager,
  LessThan,
  MoreThan,
  Repository,
} from 'typeorm';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import { hashToken } from '../common/crypto/token-hash';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { EmailVerificationEntity } from '../database/entities/email-verification.entity';
import { SocialIdentityEntity } from '../database/entities/social-identity.entity';
import { SocialLoginTransactionEntity } from '../database/entities/social-login-transaction.entity';
import { AccountsService } from '../domain/accounts/accounts.service';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';
import {
  AuthorizeFlowService,
  AuthorizeRequestInput,
} from '../oidc/authorize-flow.service';
import { HostedLoginTransactionService } from '../oidc/hosted-login-transaction.service';
import { EmailDeliveryService } from '../signup/email-delivery.service';
import { SocialIdentityProfile } from './social-provider.types';
import { SocialProvidersService } from './social-providers.service';

const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface SocialBrowserContext {
  binding: string;
  sessionAccountId: string | null;
}

export interface SocialSignupInput {
  email: string;
  name: string;
  loginId?: string;
  password?: string;
  passwordConfirm?: string;
}

export type SocialCallbackResult =
  | { kind: 'signup' }
  | {
      kind: 'authenticated';
      account: AccountEntity;
      request: AuthorizeRequestInput;
    };

@Injectable()
export class SocialLoginService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(SocialLoginTransactionEntity)
    private readonly transactions: Repository<SocialLoginTransactionEntity>,
    private readonly providers: SocialProvidersService,
    private readonly hostedTransactions: HostedLoginTransactionService,
    private readonly authorizeFlow: AuthorizeFlowService,
    private readonly accounts: AccountsService,
    private readonly crypto: AesGcmService,
    private readonly audit: AuditLogsService,
    private readonly emailDelivery: EmailDeliveryService,
    private readonly config: AppConfigService,
  ) {}

  cookieName(state: string): string {
    return `tas_social_${hashToken(state).slice(0, 24)}`;
  }

  async start(
    provider: string,
    loginTransaction: string,
    browserNonce: string,
    sessionAccountId: string | null,
  ) {
    const providerClientId = this.providers.clientIdFor(provider);
    const transaction = await this.hostedTransactions.find(
      loginTransaction,
      browserNonce,
    );
    if (!transaction || transaction.sessionAccountId !== sessionAccountId) {
      throw new BadRequestException('Invalid or expired login transaction');
    }
    const validated = await this.authorizeFlow.validateRequest(
      transaction.request,
    );
    if (validated.kind !== 'validated') {
      throw new BadRequestException('Authorization request is no longer valid');
    }
    const state = randomBytes(32).toString('base64url');
    const binding = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const authorizationUrl = this.providers.authorizationUrl(provider, {
      state,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    if (
      !(await this.hostedTransactions.consume(loginTransaction, browserNonce))
    ) {
      throw new BadRequestException('Invalid or expired login transaction');
    }
    await this.transactions.delete({ expiresAt: LessThan(new Date()) });
    await this.transactions.save(
      this.transactions.create({
        tokenHash: hashToken(state),
        browserBindingHash: hashToken(binding),
        provider,
        phase: 'authorization',
        data: {
          request: validated.request,
          sessionAccountId,
          providerClientId,
          encryptedVerifier: this.crypto.encrypt(verifier),
        },
        expiresAt: new Date(Date.now() + TRANSACTION_TTL_MS),
      }),
    );
    return { state, binding, authorizationUrl };
  }

  async callback(
    provider: string,
    state: string,
    context: SocialBrowserContext,
    code?: string,
    providerError?: string,
  ): Promise<SocialCallbackResult> {
    const transaction = await this.dataSource.transaction(async (manager) => {
      const row = await this.lockTransaction(
        manager,
        state,
        context,
        'authorization',
      );
      if (
        row.provider !== provider ||
        row.data.providerClientId !== this.providers.clientIdFor(provider)
      ) {
        throw new BadRequestException(
          'Social provider does not match this login',
        );
      }
      row.phase = 'processing';
      return manager.save(row);
    });
    if (providerError || !code || code.length > 4096) {
      throw new BadRequestException('Social login was cancelled or failed');
    }
    const profile = await this.providers.exchangeCode(provider, {
      code,
      state,
      codeVerifier: this.crypto.decrypt(transaction.data.encryptedVerifier!),
    });
    if (
      profile.provider !== provider ||
      profile.providerClientId !== transaction.data.providerClientId
    ) {
      throw new UnauthorizedException(
        'Social identity does not match this login',
      );
    }
    return this.dataSource.transaction(async (manager) => {
      const row = await this.lockTransaction(
        manager,
        state,
        context,
        'processing',
      );
      const email = profile.email ? this.normalizeEmail(profile.email) : '';
      const account = await this.resolveIdentity(
        manager,
        profile,
        email,
        profile.emailVerified,
      );
      if (account) {
        await manager.delete(SocialLoginTransactionEntity, row.id);
        return { kind: 'authenticated', account, request: row.data.request };
      }
      row.phase = 'signup';
      row.data = {
        request: row.data.request,
        sessionAccountId: row.data.sessionAccountId,
        providerClientId: row.data.providerClientId,
        profile,
        email,
        emailVerified: Boolean(email && profile.emailVerified),
      };
      row.expiresAt = new Date(Date.now() + TRANSACTION_TTL_MS);
      await manager.save(row);
      return { kind: 'signup' };
    });
  }

  async signupPage(state: string, context: SocialBrowserContext) {
    return this.dataSource.transaction(async (manager) => {
      const row = await this.lockTransaction(manager, state, context, 'signup');
      return {
        transaction: state,
        email: row.data.email ?? '',
        emailVerified: row.data.emailVerified === true,
        name: row.data.profile?.name || row.data.email?.split('@')[0] || '',
      };
    });
  }

  async sendEmailCode(
    state: string,
    context: SocialBrowserContext,
    inputEmail: string,
    ip: string | null,
  ) {
    const email = this.normalizeEmail(inputEmail);
    const code = Array.from(
      { length: 6 },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
    ).join('');
    const result = await this.dataSource.transaction(async (manager) => {
      const row = await this.lockTransaction(manager, state, context, 'signup');
      if (row.data.emailVerified || row.data.profile?.emailVerified) {
        throw new BadRequestException('Email is already verified');
      }
      if (
        row.data.lastEmailSentAt &&
        Date.now() - Date.parse(row.data.lastEmailSentAt) < 60_000
      ) {
        throw new BadRequestException('Wait 60 seconds before resending');
      }
      const verifications = manager.getRepository(EmailVerificationEntity);
      // Serialize per-email quota checks even across different login transactions.
      await this.lockKey(manager, `social-email:${email}`);
      const emailCount = await verifications.countBy({
        email,
        createdAt: MoreThan(new Date(Date.now() - 30 * 60_000)),
      });
      if (emailCount >= 5)
        throw new BadRequestException(
          'Too many verification emails for this email',
        );
      if (ip) {
        await this.lockKey(manager, `social-email-ip:${ip}`);
        const ipCount = await verifications.countBy({
          requestIp: ip,
          createdAt: MoreThan(new Date(Date.now() - 60 * 60_000)),
        });
        if (ipCount >= 10)
          throw new BadRequestException(
            'Too many verification emails from this IP',
          );
      }
      const verification = await verifications.save(
        verifications.create({
          email,
          purpose: 'social',
          contextHash: row.tokenHash,
          codeHash: this.codeHash(row.tokenHash, email, code),
          requestIp: ip,
          attemptCount: 0,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
          consumedAt: null,
        }),
      );
      row.data.email = email;
      row.data.emailVerificationId = verification.id;
      row.data.lastEmailSentAt = new Date().toISOString();
      await manager.save(row);
      return { email, expiresAt: verification.expiresAt };
    });
    await this.emailDelivery.sendSignupCode(email, code, '5 minutes');
    return result;
  }

  async verifyEmailCode(
    state: string,
    context: SocialBrowserContext,
    code: string,
  ) {
    const valid = await this.dataSource.transaction(async (manager) => {
      const row = await this.lockTransaction(manager, state, context, 'signup');
      if (row.data.emailVerified) return true;
      if (!row.data.emailVerificationId || !row.data.email) return false;
      const repository = manager.getRepository(EmailVerificationEntity);
      const verification = await repository.findOne({
        where: { id: row.data.emailVerificationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !verification ||
        verification.purpose !== 'social' ||
        verification.contextHash !== row.tokenHash ||
        verification.email !== row.data.email ||
        verification.consumedAt ||
        verification.expiresAt.getTime() <= Date.now() ||
        verification.attemptCount >= 5
      ) {
        return false;
      }
      const suppliedHash = this.codeHash(row.tokenHash, row.data.email, code);
      if (
        !timingSafeEqual(
          Buffer.from(verification.codeHash),
          Buffer.from(suppliedHash),
        )
      ) {
        verification.attemptCount += 1;
        await repository.save(verification);
        return false;
      }
      verification.consumedAt = new Date();
      await repository.save(verification);
      row.data.emailVerified = true;
      await manager.save(row);
      return true;
    });
    if (!valid)
      throw new UnauthorizedException(
        'Email verification code is expired or invalid',
      );
    return { verified: true };
  }

  async complete(
    state: string,
    context: SocialBrowserContext,
    input: SocialSignupInput,
  ): Promise<Extract<SocialCallbackResult, { kind: 'authenticated' }>> {
    const email = this.normalizeEmail(input.email);
    if (
      (input.loginId?.trim() || input.password || input.passwordConfirm) &&
      (!input.loginId?.trim() ||
        !input.password ||
        input.password !== input.passwordConfirm)
    ) {
      throw new BadRequestException(
        'Login ID and matching passwords are required together',
      );
    }
    try {
      return await this.dataSource.transaction(async (manager) => {
        const row = await this.lockTransaction(
          manager,
          state,
          context,
          'signup',
        );
        if (
          !row.data.emailVerified ||
          email !== row.data.email ||
          !row.data.profile
        ) {
          throw new UnauthorizedException(
            'Verify this email before continuing',
          );
        }
        const account = await this.resolveIdentity(
          manager,
          row.data.profile,
          email,
          true,
          input,
        );
        if (!account) throw new BadRequestException('Unable to create account');
        await manager.delete(SocialLoginTransactionEntity, row.id);
        return { kind: 'authenticated', account, request: row.data.request };
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new ConflictException(
          'Account or login ID changed. Check the ID and try again',
        );
      }
      throw error;
    }
  }

  private async resolveIdentity(
    manager: EntityManager,
    profile: SocialIdentityProfile,
    email: string,
    emailVerified: boolean,
    signup?: SocialSignupInput,
  ): Promise<AccountEntity | null> {
    await this.lockKey(
      manager,
      `social-identity:${profile.provider}:${profile.providerClientId}:${profile.subject}`,
    );
    const identities = manager.getRepository(SocialIdentityEntity);
    const identity = await identities.findOneBy({
      provider: profile.provider,
      providerClientId: profile.providerClientId,
      subject: profile.subject,
    });
    if (identity) {
      const account = await manager.findOneOrFail(AccountEntity, {
        where: { id: identity.accountId },
        lock: { mode: 'pessimistic_write' },
      });
      this.assertAccount(account);
      account.lastLoginAt = new Date();
      await manager.update(AccountEntity, account.id, {
        lastLoginAt: account.lastLoginAt,
      });
      return account;
    }
    if (!emailVerified || !email) return null;
    await this.lockKey(manager, `social-account-email:${email}`);
    const matches = await manager
      .getRepository(AccountEntity)
      .createQueryBuilder('account')
      .where('LOWER(TRIM(account.email)) = :email', { email })
      .setLock('pessimistic_write')
      .getMany();
    if (matches.length > 1)
      throw new ConflictException(
        'Email matches multiple accounts; contact the administrator',
      );
    let account = matches[0];
    if (account) {
      this.assertAccount(account);
      account.emailVerifiedAt ??= new Date();
      account.lastLoginAt = new Date();
      await manager.update(AccountEntity, account.id, {
        emailVerifiedAt: account.emailVerifiedAt,
        lastLoginAt: account.lastLoginAt,
      });
    } else if (signup) {
      account = await this.accounts.createSocialAccount(
        {
          email,
          name: signup.name,
          loginId: signup.loginId,
          password: signup.password,
        },
        manager,
      );
    } else {
      return null;
    }
    await identities.save(
      identities.create({
        accountId: account.id,
        provider: profile.provider,
        providerClientId: profile.providerClientId,
        subject: profile.subject,
      }),
    );
    await this.audit.record(
      {
        actorAccountId: account.id,
        action: 'account.link_social',
        targetType: 'account',
        targetId: account.id,
        afterJson: {
          provider: profile.provider,
          providerClientId: profile.providerClientId,
        },
      },
      manager,
    );
    return account;
  }

  private assertAccount(account: AccountEntity) {
    if (account.status !== 'active')
      throw new UnauthorizedException('Account is unavailable');
    if (account.passwordResetRequired)
      throw new UnauthorizedException('Password reset is required');
  }

  private async lockTransaction(
    manager: EntityManager,
    state: string,
    context: SocialBrowserContext,
    phase: SocialLoginTransactionEntity['phase'],
  ) {
    if (
      !state ||
      state.length > 128 ||
      !context.binding ||
      context.binding.length > 128
    ) {
      throw new BadRequestException('Invalid or expired social login');
    }
    const row = await manager
      .getRepository(SocialLoginTransactionEntity)
      .findOne({
        where: { tokenHash: hashToken(state) },
        lock: { mode: 'pessimistic_write' },
      });
    if (
      !row ||
      row.phase !== phase ||
      row.expiresAt.getTime() <= Date.now() ||
      row.browserBindingHash !== hashToken(context.binding) ||
      row.data.sessionAccountId !== context.sessionAccountId
    ) {
      throw new BadRequestException('Invalid or expired social login');
    }
    if (
      row.data.providerClientId !== this.providers.clientIdFor(row.provider)
    ) {
      throw new BadRequestException(
        'Social provider does not match this login',
      );
    }
    return row;
  }

  private async lockKey(manager: EntityManager, key: string) {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [key],
    );
  }

  private normalizeEmail(email: string): string {
    const normalized = email.trim().toLowerCase();
    if (normalized.length > 254 || !isEmail(normalized))
      throw new BadRequestException('A valid email is required');
    return normalized;
  }

  private codeHash(contextHash: string, email: string, code: string) {
    return createHash('sha256')
      .update(
        `social:${contextHash}:${email}:${code.trim().toUpperCase()}:${this.config.signupEmailCodePepper}`,
      )
      .digest('hex');
  }
}
