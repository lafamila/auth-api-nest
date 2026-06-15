import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import { PasswordService } from '../common/crypto/password.service';
import { validateNormalPassword } from '../common/crypto/password-policy';
import { hashSecret } from '../common/crypto/secret-hash';
import { TotpService } from '../common/crypto/totp.service';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { AdminBootstrapChallengeEntity } from '../database/entities/admin-bootstrap-challenge.entity';
import { AdminMfaEntity } from '../database/entities/admin-mfa.entity';
import { AdminSessionEntity } from '../database/entities/admin-session.entity';
import { AccountsService } from '../domain/accounts/accounts.service';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';
import {
  AdminLoginDto,
  BootstrapCompleteDto,
  BootstrapStartDto,
} from './dto/admin-auth.dto';

type SignedCookieRequest = Request & {
  signedCookies?: Record<string, string | undefined>;
  adminAccount?: AccountEntity;
  adminSession?: AdminSessionEntity;
};

const ADMIN_IDLE_MS = 30 * 60 * 1000;
const ADMIN_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const BOOTSTRAP_CHALLENGE_MS = 15 * 60 * 1000;

@Injectable()
export class AdminAuthService {
  constructor(
    @InjectRepository(AdminBootstrapChallengeEntity)
    private readonly bootstrapChallenges: Repository<AdminBootstrapChallengeEntity>,
    @InjectRepository(AdminMfaEntity)
    private readonly mfa: Repository<AdminMfaEntity>,
    @InjectRepository(AdminSessionEntity)
    private readonly sessions: Repository<AdminSessionEntity>,
    private readonly dataSource: DataSource,
    private readonly accounts: AccountsService,
    private readonly passwordService: PasswordService,
    private readonly aes: AesGcmService,
    private readonly totp: TotpService,
    private readonly config: AppConfigService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async bootstrapStatus(): Promise<{ requiresBootstrap: boolean; activeSuperAdminCount: number }> {
    const activeSuperAdminCount = await this.accounts.countActiveSuperAdmins();
    return {
      requiresBootstrap: activeSuperAdminCount === 0,
      activeSuperAdminCount,
    };
  }

  async startBootstrap(input: BootstrapStartDto) {
    await this.assertBootstrapAvailable();
    validateNormalPassword(input.password);
    const existing = await this.dataSource.getRepository(AccountEntity).exists({
      where: [{ loginId: input.loginId }, { email: input.email }],
    });
    if (existing) {
      throw new ConflictException('Account loginId or email already exists');
    }
    const otpSecret = this.totp.generateSecret();
    const challenge = await this.bootstrapChallenges.save(
      this.bootstrapChallenges.create({
        loginId: input.loginId,
        name: input.name,
        email: input.email,
        passwordHash: await this.passwordService.hash(input.password),
        encryptedOtpSecret: this.aes.encrypt(otpSecret),
        expiresAt: new Date(Date.now() + BOOTSTRAP_CHALLENGE_MS),
        consumedAt: null,
      }),
    );
    const otpauthUri = this.totp.otpauthUri({
      secret: otpSecret,
      loginId: input.loginId,
    });
    return {
      challengeId: challenge.id,
      otpSecret,
      otpauthUri,
      otpQrDataUrl: await QRCode.toDataURL(otpauthUri, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 192,
      }),
      expiresAt: challenge.expiresAt,
    };
  }

  async completeBootstrap(input: BootstrapCompleteDto) {
    await this.assertBootstrapAvailable();
    const challenge = await this.bootstrapChallenges.findOneBy({
      id: input.challengeId,
      consumedAt: IsNull(),
    });
    if (!challenge || challenge.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Bootstrap challenge is expired or invalid');
    }
    const otpSecret = this.aes.decrypt(challenge.encryptedOtpSecret);
    if (!this.totp.verify(otpSecret, input.otpCode)) {
      throw new UnauthorizedException('Invalid OTP code');
    }

    const result = await this.dataSource.transaction(async (manager) => {
      if (
        await manager.exists(AccountEntity, {
          where: [{ loginId: challenge.loginId }, { email: challenge.email }],
        })
      ) {
        throw new ConflictException('Account loginId or email already exists');
      }
      const account = await manager.save(
        manager.create(AccountEntity, {
          loginId: challenge.loginId,
          name: challenge.name,
          email: challenge.email,
          passwordHash: challenge.passwordHash,
          status: 'active',
          isSuperAdmin: true,
          passwordResetRequired: false,
          emailVerifiedAt: new Date(),
          lastLoginAt: null,
        }),
      );
      await manager.save(
        manager.create(AdminMfaEntity, {
          account,
          accountId: account.id,
          encryptedOtpSecret: challenge.encryptedOtpSecret,
          verifiedAt: new Date(),
        }),
      );
      challenge.consumedAt = new Date();
      await manager.save(challenge);
      return account;
    });

    await this.auditLogs.record({
      actorAccountId: result.id,
      action: 'admin.bootstrap.complete',
      targetType: 'account',
      targetId: result.id,
      afterJson: this.accounts.safeAccount(result),
    });

    return { account: this.accounts.safeAccount(result) };
  }

  async login(input: AdminLoginDto, request: Request, response: Response) {
    const account = await this.accounts.authenticateIgnoringResetRequirement(
      input.loginId,
      input.password,
    );
    if (!account.isSuperAdmin || account.passwordResetRequired) {
      throw new UnauthorizedException('Superadmin credentials are required');
    }
    const mfa = await this.mfa.findOneBy({ accountId: account.id });
    if (!mfa) {
      throw new UnauthorizedException('Admin MFA is not configured');
    }
    const otpSecret = this.aes.decrypt(mfa.encryptedOtpSecret);
    if (!this.totp.verify(otpSecret, input.otpCode)) {
      throw new UnauthorizedException('Invalid OTP code');
    }
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const session = await this.sessions.save(
      this.sessions.create({
        account,
        accountId: account.id,
        tokenHash: hashSecret(token),
        idleExpiresAt: new Date(now.getTime() + ADMIN_IDLE_MS),
        absoluteExpiresAt: new Date(now.getTime() + ADMIN_ABSOLUTE_MS),
        lastSeenAt: now,
        revokedAt: null,
        ipAddress: this.ipAddress(request),
        userAgent: request.header('user-agent') ?? null,
      }),
    );
    response.cookie(this.config.adminSessionCookieName, token, {
      httpOnly: true,
      secure: this.config.nodeEnv === 'production',
      sameSite: 'lax',
      signed: true,
      maxAge: ADMIN_ABSOLUTE_MS,
    });
    await this.auditLogs.record({
      actorAccountId: account.id,
      action: 'admin.session.create',
      targetType: 'admin_session',
      targetId: session.id,
    });
    return {
      account: this.accounts.safeAccount(account),
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  async validateRequest(request: SignedCookieRequest): Promise<AccountEntity> {
    const token = request.signedCookies?.[this.config.adminSessionCookieName];
    if (!token) {
      throw new UnauthorizedException('Admin session is required');
    }
    const session = await this.sessions.findOne({
      where: { tokenHash: hashSecret(token), revokedAt: IsNull() },
      relations: { account: true },
    });
    const now = Date.now();
    if (
      !session ||
      session.idleExpiresAt.getTime() <= now ||
      session.absoluteExpiresAt.getTime() <= now ||
      session.account.status !== 'active' ||
      !session.account.isSuperAdmin
    ) {
      throw new UnauthorizedException('Admin session is invalid or expired');
    }
    session.lastSeenAt = new Date(now);
    session.idleExpiresAt = new Date(Math.min(now + ADMIN_IDLE_MS, session.absoluteExpiresAt.getTime()));
    await this.sessions.save(session);
    request.adminAccount = session.account;
    request.adminSession = session;
    return session.account;
  }

  async logout(request: SignedCookieRequest, response: Response): Promise<void> {
    const token = request.signedCookies?.[this.config.adminSessionCookieName];
    if (token) {
      await this.sessions.update(
        { tokenHash: hashSecret(token), revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
    }
    response.clearCookie(this.config.adminSessionCookieName);
  }

  private async assertBootstrapAvailable(): Promise<void> {
    if ((await this.accounts.countActiveSuperAdmins()) > 0) {
      throw new ConflictException('Bootstrap is closed');
    }
  }

  private ipAddress(request: Request): string | null {
    const forwarded = request.header('x-forwarded-for')?.split(',')[0]?.trim();
    return forwarded || request.ip || null;
  }
}
