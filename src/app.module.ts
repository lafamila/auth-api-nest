import { Module } from '@nestjs/common';
import { AccountsModule } from './domain/accounts/accounts.module';
import { AccountPermissionsModule } from './domain/account-permissions/account-permissions.module';
import { AdminModule } from './admin/admin.module';
import { AuditLogsModule } from './domain/audit-logs/audit-logs.module';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { OidcClientsModule } from './domain/oidc-clients/oidc-clients.module';
import { OidcModule } from './oidc/oidc.module';
import { PermissionsModule } from './domain/permissions/permissions.module';
import { ServiceRegistryModule } from './domain/service-registry/service-registry.module';
import { ServiceApplicationsModule } from './domain/service-applications/service-applications.module';
import { ServiceOnboardingModule } from './domain/service-onboarding/service-onboarding.module';
import { SignupModule } from './signup/signup.module';
import { InternalModule } from './internal/internal.module';
import { ServicePageController } from './service-page.controller';
import { NotificationModule } from './notifications/notification.module';
import { PublicSiteModule } from './public-site/public-site.module';
import { ProviderEventsModule } from './social/provider-events/provider-events.module';
import { PrivacyRetentionModule } from './policies/privacy-retention.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    AccountsModule,
    ServiceRegistryModule,
    OidcClientsModule,
    PermissionsModule,
    AccountPermissionsModule,
    AuditLogsModule,
    AdminModule,
    InternalModule,
    OidcModule,
    ServiceApplicationsModule,
    ServiceOnboardingModule,
    SignupModule,
    NotificationModule,
    PublicSiteModule,
    ProviderEventsModule,
    PrivacyRetentionModule,
  ],
  controllers: [HealthController, ServicePageController],
})
export class AppModule {}
