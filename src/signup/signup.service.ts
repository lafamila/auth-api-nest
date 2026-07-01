import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomInt } from 'node:crypto';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { validateNormalPassword } from '../common/crypto/password-policy';
import { AppConfigService } from '../config/app-config.service';
import { EmailVerificationEntity } from '../database/entities/email-verification.entity';
import { AccountsService } from '../domain/accounts/accounts.service';
import { EmailDeliveryService } from './email-delivery.service';
import {
  SignupCompleteDto,
  SignupLoginIdCheckDto,
  SignupStartDto,
  SignupVerifyCodeDto,
} from './dto/signup.dto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MINUTES = 5;
const CODE_TTL_MS = CODE_TTL_MINUTES * 60 * 1000;
const EMAIL_WINDOW_MS = 30 * 60 * 1000;
const IP_WINDOW_MS = 60 * 60 * 1000;

@Injectable()
export class SignupService {
  constructor(
    @InjectRepository(EmailVerificationEntity)
    private readonly verifications: Repository<EmailVerificationEntity>,
    private readonly accounts: AccountsService,
    private readonly config: AppConfigService,
    private readonly emailDelivery: EmailDeliveryService,
  ) {}

  async checkLoginId(input: SignupLoginIdCheckDto) {
    const loginId = this.normalizeLoginId(input.loginId);
    if (!loginId) {
      throw new BadRequestException('Login ID is required');
    }
    return {
      loginId,
      available: (await this.accounts.findByLoginId(loginId)) === null,
    };
  }

  async start(input: SignupStartDto, requestIp: string | null) {
    const email = this.normalizeEmail(input.email);
    if (await this.emailExists(email)) {
      throw new ConflictException('Email already has an account');
    }
    await this.assertRateLimits(email, requestIp);
    const code = this.generateCode();
    const verification = await this.verifications.save(
      this.verifications.create({
        email,
        codeHash: this.hashCode(email, code),
        requestIp,
        attemptCount: 0,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
        consumedAt: null,
      }),
    );
    await this.emailDelivery.sendSignupCode(
      email,
      code,
      `${CODE_TTL_MINUTES} minutes`,
    );
    return {
      verificationId: verification.id,
      email,
      expiresAt: verification.expiresAt,
    };
  }

  async verifyCode(input: SignupVerifyCodeDto) {
    const email = this.normalizeEmail(input.email);
    await this.findValidVerification(email, input.code, { consume: false });
    return { email, verified: true };
  }

  async complete(input: SignupCompleteDto) {
    const loginId = this.normalizeLoginId(input.loginId);
    if (!loginId) {
      throw new BadRequestException('Login ID is required');
    }
    const email = this.normalizeEmail(input.email);
    const name = input.name.trim();
    if (!name) {
      throw new BadRequestException('Name is required');
    }
    validateNormalPassword(input.password);
    if (await this.accounts.findByLoginId(loginId)) {
      throw new ConflictException('Login ID already exists');
    }
    if (await this.emailExists(email)) {
      throw new ConflictException('Email already has an account');
    }
    await this.findValidVerification(email, input.code, { consume: true });
    const account = await this.accounts.create(
      {
        loginId,
        name,
        email,
        password: input.password,
        isSuperAdmin: false,
      },
      null,
      { emailVerifiedAt: new Date(), passwordResetRequired: false },
    );
    return { account: this.accounts.safeAccount(account) };
  }

  private async emailExists(email: string): Promise<boolean> {
    return (await this.accounts.findByEmail(email)) !== null;
  }

  private async assertRateLimits(
    email: string,
    requestIp: string | null,
  ): Promise<void> {
    const emailRecent = await this.verifications.countBy({
      email,
      createdAt: MoreThan(new Date(Date.now() - EMAIL_WINDOW_MS)),
    });
    if (emailRecent >= 5) {
      throw new BadRequestException(
        'Too many verification emails for this email',
      );
    }
    if (requestIp) {
      const ipRecent = await this.verifications.countBy({
        requestIp,
        createdAt: MoreThan(new Date(Date.now() - IP_WINDOW_MS)),
      });
      if (ipRecent >= 10) {
        throw new BadRequestException(
          'Too many verification emails from this IP',
        );
      }
    }
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private normalizeLoginId(loginId: string): string {
    return loginId.trim();
  }

  private generateCode(): string {
    let code = '';
    for (let index = 0; index < 6; index += 1) {
      code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
    }
    return code;
  }

  private hashCode(email: string, code: string): string {
    return createHash('sha256')
      .update(
        `${email}:${code.toUpperCase()}:${this.config.signupEmailCodePepper}`,
      )
      .digest('hex');
  }

  private async findValidVerification(
    email: string,
    code: string,
    options: { consume: boolean },
  ): Promise<EmailVerificationEntity> {
    const verification = await this.verifications.findOne({
      where: { email, consumedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    if (!verification || verification.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException(
        'Email verification code is expired or invalid',
      );
    }
    if (verification.attemptCount >= 5) {
      throw new BadRequestException('Too many verification attempts');
    }
    if (verification.codeHash !== this.hashCode(email, code)) {
      verification.attemptCount += 1;
      await this.verifications.save(verification);
      throw new UnauthorizedException(
        'Email verification code is expired or invalid',
      );
    }
    if (options.consume) {
      verification.consumedAt = new Date();
      await this.verifications.save(verification);
    }
    return verification;
  }
}
