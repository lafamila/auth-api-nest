import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';

@Injectable()
export class AuthSchemaReadinessService implements OnModuleInit {
  constructor(
    private readonly source: DataSource,
    private readonly config: AppConfigService,
  ) {}
  async onModuleInit(): Promise<void> {
    if (this.config.nodeEnv === 'production') {
      for (const [name, value] of [
        ['COOKIE_SECRET', this.config.cookieSecret],
        ['ADMIN_OTP_ENCRYPTION_KEY', this.config.adminOtpEncryptionKey],
        ['SIGNUP_EMAIL_CODE_PEPPER', this.config.signupEmailCodePepper],
      ]) {
        if (value.length < 32 || /^(?:change-me|dev-|test-)/i.test(value))
          throw new Error(
            `${name} must be a stable production secret, not a sample value. Existing encrypted data must be migrated before rotating its key.`,
          );
      }
    }
    const [schema] = await this.source.query<
      Array<Record<string, boolean>>
    >(`SELECT
      to_regclass('account_policy_consents') IS NOT NULL AS policy_consents,
      to_regclass('provider_revocation_jobs') IS NOT NULL AS provider_revocations,
      to_regclass('provider_events') IS NOT NULL AS provider_events,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='services' AND column_name='category') AS service_category,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='accounts' AND column_name='credential_version') AS credential_version,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='social_identities' AND column_name='encrypted_revocation_grant') AS provider_grants`);
    if (!schema || Object.values(schema).some((present) => !present))
      throw new Error(
        'Auth schema is not ready. Back up the database and apply migrations through AddServiceCategories20261118000003 before starting this version (RUN_MIGRATIONS=true).',
      );
  }
}
