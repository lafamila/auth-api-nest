import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { isEmail } from 'class-validator';
import { randomInt } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  MoreThan,
  Not,
  QueryFailedError,
  Raw,
} from 'typeorm';
import { validateNormalPassword } from '../common/crypto/password-policy';
import { PasswordService } from '../common/crypto/password.service';
import { hashSecret, verifySecretHash } from '../common/crypto/secret-hash';
import { AppConfigService } from '../config/app-config.service';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { AccountEntity } from '../database/entities/account.entity';
import { EmailVerificationEntity } from '../database/entities/email-verification.entity';
import { SocialIdentityEntity } from '../database/entities/social-identity.entity';
import { AccountsService } from '../domain/accounts/accounts.service';
import { EmailDeliveryService } from '../signup/email-delivery.service';
import { SocialProvidersService } from '../social/social-providers.service';
import {
  PortalEmailCompleteDto,
  PortalEmailStartDto,
  PortalEmailStartResult,
  PortalOverviewDto,
  PortalPasswordDto,
  PortalReauthenticateResult,
} from './portal-profile.dto';
import { PortalActor, RECENT_AUTH_MS } from './portal.types';

const EMAIL_PURPOSE = 'account_email_change';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

@Injectable()
export class PortalProfileService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly accounts: AccountsService,
    private readonly passwords: PasswordService,
    private readonly providers: SocialProvidersService,
    private readonly emailDelivery: EmailDeliveryService,
    private readonly config: AppConfigService,
  ) {}

  async overview(actor: PortalActor): Promise<PortalOverviewDto> {
    return this.dataSource.transaction(async (manager) => {
      const account = await this.lockAccount(manager, actor);
      const assignments = await manager
        .getRepository(AccountServicePermissionEntity)
        .find({
          where: { accountId: account.id, status: 'active' },
          relations: { service: true, permissionDefinition: true },
          order: { grantedAt: 'ASC' },
        });
      const identities = await manager
        .getRepository(SocialIdentityEntity)
        .find({
          where: { accountId: account.id },
          order: { createdAt: 'ASC' },
        });
      const socialProviders = new Map<
        string,
        PortalOverviewDto['socialProviders'][number]
      >(
        this.providers
          .list()
          .map(({ key, label }) => [
            key,
            { key, label, linked: false, enabled: true, linkedAt: null },
          ]),
      );
      for (const identity of identities) {
        if (identity.accountId !== account.id) continue;
        const provider = socialProviders.get(identity.provider) ?? {
          key: identity.provider,
          label:
            identity.provider.charAt(0).toUpperCase() +
            identity.provider.slice(1),
          linked: false,
          enabled: false,
          linkedAt: null,
        };
        provider.linked = true;
        if (!provider.linkedAt || identity.createdAt < provider.linkedAt) {
          provider.linkedAt = identity.createdAt;
        }
        socialProviders.set(identity.provider, provider);
      }
      return {
        account: {
          id: account.id,
          loginId: account.loginId,
          hasLocalCredentials: this.hasLocalCredentials(account),
          name: account.name,
          email: account.email,
          status: account.status,
          isSuperAdmin: account.isSuperAdmin,
          passwordResetRequired: account.passwordResetRequired,
          emailVerifiedAt: account.emailVerifiedAt,
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
          lastLoginAt: account.lastLoginAt,
        },
        services: assignments
          .filter((assignment) => {
            const permission = assignment.permissionDefinition;
            return (
              assignment.accountId === account.id &&
              assignment.status === 'active' &&
              !assignment.revokedAt &&
              assignment.service?.status === 'active' &&
              permission &&
              permission.status !== 'removed' &&
              !permission.removedAt &&
              !['visitor', 'guest'].includes(
                permission.key.trim().toLowerCase(),
              )
            );
          })
          .map(({ service, permissionDefinition, grantedAt }) => ({
            id: service.id,
            key: service.serviceKey,
            name: service.name,
            description: service.description,
            permission: {
              key: permissionDefinition.key,
              label: permissionDefinition.label,
            },
            grantedAt,
          })),
        socialProviders: [...socialProviders.values()],
        csrfToken: actor.csrfToken,
      };
    });
  }

  async startEmailChange(
    actor: PortalActor,
    input: PortalEmailStartDto,
    ip: string | null,
  ): Promise<PortalEmailStartResult> {
    const email = this.normalizeEmail(input.email);
    const code = Array.from(
      { length: 6 },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
    ).join('');
    const result = await this.dataSource.transaction(async (manager) => {
      const account = await this.lockAccount(manager, actor);
      await this.requireCurrentPassword(account, input.currentPassword);
      await this.assertEmailAvailable(manager, account, email);
      const contextHash = this.emailContext(actor);
      await this.assertEmailRateLimits(manager, email, contextHash, ip);
      const verifications = manager.getRepository(EmailVerificationEntity);
      const verification = await verifications.save(
        verifications.create({
          email,
          purpose: EMAIL_PURPOSE,
          contextHash,
          codeHash: hashSecret(this.emailCodeValue(contextHash, email, code)),
          requestIp: ip,
          attemptCount: 0,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
          consumedAt: null,
        }),
      );
      return {
        verificationId: verification.id,
        email: verification.email,
        expiresAt: verification.expiresAt,
      };
    });
    await this.emailDelivery.sendSignupCode(result.email, code, '5 minutes');
    return result;
  }

  async completeEmailChange(
    actor: PortalActor,
    input: PortalEmailCompleteDto,
  ): Promise<PortalReauthenticateResult> {
    let failure: HttpException | null;
    try {
      failure = await this.dataSource.transaction(async (manager) => {
        const account = await this.lockAccount(manager, actor);
        if (!this.hasLocalCredentials(account)) {
          throw new ForbiddenException(
            'Email changes require local credentials',
          );
        }
        const verifications = manager.getRepository(EmailVerificationEntity);
        const verification = await verifications.findOne({
          where: { id: input.verificationId },
          lock: { mode: 'pessimistic_write' },
        });
        const contextHash = this.emailContext(actor);
        if (
          !verification ||
          verification.purpose !== EMAIL_PURPOSE ||
          verification.contextHash !== contextHash ||
          verification.consumedAt ||
          verification.expiresAt.getTime() <= Date.now()
        ) {
          return this.invalidEmailVerification();
        }
        if (verification.attemptCount >= MAX_ATTEMPTS) {
          return new BadRequestException('Too many verification attempts');
        }
        if (
          !verifySecretHash(
            verification.codeHash,
            this.emailCodeValue(contextHash, verification.email, input.code),
          )
        ) {
          await verifications.increment(
            { id: verification.id },
            'attemptCount',
            1,
          );
          // Return the error so the failed attempt commits before it is thrown.
          return this.invalidEmailVerification();
        }
        const email = this.normalizeEmail(verification.email);
        await this.assertEmailAvailable(manager, account, email);
        await manager.getRepository(AccountEntity).update(account.id, {
          email,
          emailVerifiedAt: new Date(),
          credentialVersion: account.credentialVersion + 1,
        });
        await verifications.update(verification.id, { consumedAt: new Date() });
        await this.accounts.revokeAccountSessions(account.id, manager);
        return null;
      });
    } catch (error) {
      this.rethrowUniqueConflict(error, 'Email already has an account');
    }
    if (failure) throw failure;
    return { reauthenticate: true };
  }

  async changePassword(
    actor: PortalActor,
    input: PortalPasswordDto,
  ): Promise<PortalReauthenticateResult> {
    if (typeof input.password !== 'string') {
      throw new BadRequestException('Password is required');
    }
    validateNormalPassword(input.password);
    if (input.password !== input.passwordConfirm) {
      throw new BadRequestException('Passwords do not match');
    }
    if (input.loginId !== undefined && typeof input.loginId !== 'string') {
      throw new BadRequestException('Invalid login ID');
    }
    try {
      await this.dataSource.transaction(async (manager) => {
        const account = await this.lockAccount(manager, actor);
        const loginId = input.loginId?.trim();
        if (
          account.loginId &&
          loginId !== undefined &&
          loginId !== account.loginId
        ) {
          throw new BadRequestException(
            'An existing login ID cannot be changed',
          );
        }
        if (this.hasLocalCredentials(account)) {
          await this.requireCurrentPassword(account, input.currentPassword);
        } else {
          this.requireRecentAuthentication(actor);
          if (!account.loginId && !loginId) {
            throw new BadRequestException('Login ID is required');
          }
          const owner = await manager.getRepository(AccountEntity).findOneBy({
            loginId: account.loginId ?? loginId!,
          });
          if (owner && owner.id !== account.id) {
            throw new ConflictException('Login ID already exists');
          }
        }
        const passwordHash = await this.passwords.hash(input.password);
        await manager.getRepository(AccountEntity).update(account.id, {
          ...(!account.loginId ? { loginId } : {}),
          passwordHash,
          passwordResetRequired: false,
          credentialVersion: account.credentialVersion + 1,
        });
        await this.accounts.revokeAccountSessions(account.id, manager);
      });
    } catch (error) {
      this.rethrowUniqueConflict(error, 'Login ID already exists');
    }
    return { reauthenticate: true };
  }

  private async lockAccount(manager: EntityManager, actor: PortalActor) {
    const account = await manager.getRepository(AccountEntity).findOne({
      where: { id: actor.account.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!account || account.status !== 'active') {
      throw new UnauthorizedException('Account is not active');
    }
    if (
      !Number.isSafeInteger(account.credentialVersion) ||
      account.credentialVersion !== actor.account.credentialVersion
    ) {
      throw this.reauthenticationRequired();
    }
    return account;
  }

  private hasLocalCredentials(account: AccountEntity): boolean {
    return Boolean(account.loginId && account.passwordHash);
  }

  private async requireCurrentPassword(
    account: AccountEntity,
    password?: string,
  ) {
    if (!this.hasLocalCredentials(account)) {
      throw new ForbiddenException('Email changes require local credentials');
    }
    if (
      typeof password !== 'string' ||
      !password ||
      !(await this.passwords.verify(account.passwordHash!, password))
    ) {
      throw new UnauthorizedException({
        code: 'invalid_current_password',
        message: 'Current password is required or invalid',
      });
    }
  }

  private requireRecentAuthentication(actor: PortalActor): void {
    const authenticatedAt = actor.session.metadataJson?.authenticatedAt;
    const timestamp =
      authenticatedAt === undefined
        ? actor.session.createdAt.getTime()
        : typeof authenticatedAt === 'string' &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
              authenticatedAt,
            )
          ? Date.parse(authenticatedAt)
          : Number.NaN;
    const age = Date.now() - timestamp;
    if (!Number.isFinite(age) || age < 0 || age > RECENT_AUTH_MS) {
      throw this.reauthenticationRequired();
    }
  }

  private reauthenticationRequired(): HttpException {
    return new HttpException(
      {
        code: 'reauthentication_required',
        message: 'Please authenticate again before changing credentials',
      },
      HttpStatus.FORBIDDEN,
    );
  }

  private invalidEmailVerification(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'invalid_email_verification',
      message: 'Email verification is expired or invalid',
    });
  }

  private normalizeEmail(value: string): string {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!isEmail(email)) throw new BadRequestException('Invalid email');
    return email;
  }

  private async assertEmailAvailable(
    manager: EntityManager,
    account: AccountEntity,
    email: string,
  ): Promise<void> {
    if (account.email.trim().toLowerCase() === email) {
      throw new BadRequestException('Email is unchanged');
    }
    const owned = await manager.getRepository(AccountEntity).exists({
      where: {
        id: Not(account.id),
        email: Raw((alias) => `LOWER(BTRIM(${alias})) = :portalEmail`, {
          portalEmail: email,
        }),
      },
    });
    if (owned) throw new ConflictException('Email already has an account');
  }

  private emailContext(actor: PortalActor): string {
    return hashSecret(
      JSON.stringify([
        EMAIL_PURPOSE,
        actor.account.id,
        actor.session.tokenHash,
        actor.account.credentialVersion,
      ]),
    );
  }

  private emailCodeValue(
    contextHash: string,
    email: string,
    code: string,
  ): string {
    return JSON.stringify([
      EMAIL_PURPOSE,
      contextHash,
      email,
      code.toUpperCase(),
      this.config.signupEmailCodePepper,
    ]);
  }

  private async assertEmailRateLimits(
    manager: EntityManager,
    email: string,
    contextHash: string,
    ip: string | null,
  ): Promise<void> {
    // Share social verification quota locks and count every verification purpose.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `social-email:${email}`,
    ]);
    if (ip) {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `social-email-ip:${ip}`,
      ]);
    }
    const verifications = manager.getRepository(EmailVerificationEntity);
    const latest = await verifications.findOne({
      where: [{ purpose: EMAIL_PURPOSE, contextHash }, { email }],
      order: { createdAt: 'DESC' },
    });
    if (latest && Date.now() - latest.createdAt.getTime() < 60_000) {
      throw new BadRequestException('Wait 60 seconds before resending');
    }
    if (
      (await verifications.countBy({
        email,
        createdAt: MoreThan(new Date(Date.now() - 30 * 60_000)),
      })) >= 5
    ) {
      throw new BadRequestException(
        'Too many verification emails for this email',
      );
    }
    if (
      ip &&
      (await verifications.countBy({
        requestIp: ip,
        createdAt: MoreThan(new Date(Date.now() - 60 * 60_000)),
      })) >= 10
    ) {
      throw new BadRequestException(
        'Too many verification emails from this IP',
      );
    }
  }

  private rethrowUniqueConflict(error: unknown, message: string): never {
    if (
      error instanceof QueryFailedError &&
      error.driverError?.code === '23505'
    ) {
      throw new ConflictException(message);
    }
    throw error;
  }
}
