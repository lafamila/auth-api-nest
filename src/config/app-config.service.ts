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

  get adminApiKey(): string {
    return this.config.get<string>('ADMIN_API_KEY', 'dev-admin-key');
  }

  get cookieSecret(): string {
    return this.config.get<string>('COOKIE_SECRET', 'dev-cookie-secret');
  }

  get corsOrigins(): string[] {
    const raw = this.config.get<string>('CORS_ORIGINS', '');
    if (!raw) {
      return [this.issuerUrl, 'http://localhost:3030', 'http://localhost:3031'];
    }
    return raw.split(',').map((origin) => origin.trim());
  }

  get seedAdmin() {
    return {
      loginId: this.config.get<string>('SEED_ADMIN_LOGIN_ID', 'superadmin'),
      password: this.config.get<string>(
        'SEED_ADMIN_PASSWORD',
        'superadmin-password',
      ),
      email: this.config.get<string>('SEED_ADMIN_EMAIL', 'admin@lafamila.xyz'),
      name: this.config.get<string>('SEED_ADMIN_NAME', 'Teddy Super Admin'),
    };
  }
}
