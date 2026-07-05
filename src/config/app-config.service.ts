import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  get nodeEnv(): string {
    return this.config.get<string>('NODE_ENV', 'development');
  }

  get port(): number {
    return Number(this.config.get<string>('PORT', '3032'));
  }

  get issuerUrl(): string {
    return this.config.get<string>('ISSUER_URL', 'http://localhost:3032');
  }

  get databaseUrl(): string {
    return this.config.get<string>(
      'DATABASE_URL',
      'postgres://postgres:postgres@localhost:5432/teddy_auth',
    );
  }

  get runMigrations(): boolean {
    return this.config.get<string>('RUN_MIGRATIONS', 'false') === 'true';
  }

  get cookieSecret(): string {
    return this.config.get<string>('COOKIE_SECRET', 'dev-cookie-secret');
  }

  get refreshRotationGraceSeconds(): number {
    return Number(
      this.config.get<string>('REFRESH_ROTATION_GRACE_SECONDS', '60'),
    );
  }

  get adminSessionCookieName(): string {
    return this.config.get<string>('ADMIN_SESSION_COOKIE_NAME', 'tas_admin_session');
  }

  get adminOtpEncryptionKey(): string {
    return this.config.get<string>(
      'ADMIN_OTP_ENCRYPTION_KEY',
      'dev-admin-otp-encryption-key-change-me',
    );
  }

  get signupEmailCodePepper(): string {
    return this.config.get<string>(
      'SIGNUP_EMAIL_CODE_PEPPER',
      this.cookieSecret,
    );
  }

  get smtp() {
    return {
      host: this.config.get<string>('SMTP_HOST', ''),
      port: Number(this.config.get<string>('SMTP_PORT', '587')),
      user: this.config.get<string>('SMTP_USER', ''),
      password: this.config.get<string>('SMTP_PASSWORD', ''),
      from: this.config.get<string>('SMTP_FROM', 'auth@lafamila.xyz'),
    };
  }

  get corsOrigins(): string[] {
    const raw = this.config.get<string>('CORS_ORIGINS', '');
    if (!raw) {
      return [this.issuerUrl, 'http://localhost:3030', 'http://localhost:3031'];
    }
    return raw.split(',').map((origin) => origin.trim());
  }
}
