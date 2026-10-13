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

  get accessTokenTtlSeconds(): number {
    return Number(this.config.get<string>('ACCESS_TOKEN_TTL_SECONDS', '900'));
  }

  get refreshTokenTtlSeconds(): number {
    return Number(
      this.config.get<string>('REFRESH_TOKEN_TTL_SECONDS', '604800'),
    );
  }

  get refreshRotationGraceSeconds(): number {
    return Number(
      this.config.get<string>('REFRESH_ROTATION_GRACE_SECONDS', '60'),
    );
  }

  get permissionWebhooksEnabled(): boolean {
    return (
      this.config.get<string>('PERMISSION_WEBHOOKS_ENABLED', 'false') === 'true'
    );
  }

  get permissionWebhookRequestTimeoutMs(): number {
    return this.positiveNumber('PERMISSION_WEBHOOK_REQUEST_TIMEOUT_MS', 5000);
  }

  get permissionWebhookPollIntervalMs(): number {
    return this.positiveNumber('PERMISSION_WEBHOOK_POLL_INTERVAL_MS', 1000);
  }

  get permissionWebhookMaxAttempts(): number {
    return this.positiveNumber('PERMISSION_WEBHOOK_MAX_ATTEMPTS', 6);
  }

  get permissionWebhookTrustedInternalOrigins(): string[] {
    const raw = this.config.get<string>(
      'PERMISSION_WEBHOOK_TRUSTED_INTERNAL_ORIGINS',
      '',
    );
    return raw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  get notificationsEnabled(): boolean {
    return this.config.get<string>('NOTIFICATIONS_ENABLED', 'false') === 'true';
  }

  get notificationTokenEncryptionKey(): string {
    return this.config.get<string>('NOTIFICATION_TOKEN_ENCRYPTION_KEY', '');
  }

  get notificationPollIntervalMs(): number {
    return this.positiveNumber('NOTIFICATION_POLL_INTERVAL_MS', 1000);
  }

  get notificationRetentionIntervalMs(): number {
    return this.positiveNumber(
      'NOTIFICATION_RETENTION_INTERVAL_MS',
      60 * 60 * 1000,
    );
  }

  get firebaseProjectId(): string {
    return this.config.get<string>('FIREBASE_PROJECT_ID', '');
  }

  get firebaseClientEmail(): string {
    return this.config.get<string>('FIREBASE_CLIENT_EMAIL', '');
  }

  get firebasePrivateKey(): string {
    return this.config
      .get<string>('FIREBASE_PRIVATE_KEY', '')
      .replace(/\\n/g, '\n');
  }

  permissionWebhookEnvironmentSecret(serviceKey: string): {
    envName: string;
    secret: string;
  } {
    const envName = `PERMISSION_WEBHOOK_SECRET_${serviceKey
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '_')}`;
    return {
      envName,
      secret: this.config.get<string>(envName, ''),
    };
  }

  get adminSessionCookieName(): string {
    return this.config.get<string>(
      'ADMIN_SESSION_COOKIE_NAME',
      'tas_admin_session',
    );
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

  private positiveNumber(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key, String(fallback)));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}
