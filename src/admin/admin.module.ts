import { Module } from '@nestjs/common';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { AccountPermissionsModule } from '../domain/account-permissions/account-permissions.module';
import { AppConfigModule } from '../config/app-config.module';
import { AuditLogsModule } from '../domain/audit-logs/audit-logs.module';
import { OidcClientsModule } from '../domain/oidc-clients/oidc-clients.module';
import { PermissionsModule } from '../domain/permissions/permissions.module';
import { ServiceRegistryModule } from '../domain/service-registry/service-registry.module';
import { ServiceCredentialsModule } from '../domain/service-credentials/service-credentials.module';
import { ServiceOnboardingModule } from '../domain/service-onboarding/service-onboarding.module';
import { AdminAuthController } from './controllers/admin-auth.controller';
import { AdminAccountsController } from './controllers/admin-accounts.controller';
import { AdminAuditLogsController } from './controllers/admin-audit-logs.controller';
import { AdminClientsController } from './controllers/admin-clients.controller';
import { AdminPermissionDashboardController } from './controllers/admin-permission-dashboard.controller';
import { AdminPermissionsController } from './controllers/admin-permissions.controller';
import { AdminServiceCredentialScopesController } from './controllers/admin-service-credential-scopes.controller';
import { AdminServiceCredentialsController } from './controllers/admin-service-credentials.controller';
import { AdminServicesController } from './controllers/admin-services.controller';
import { AdminServiceOnboardingController } from './controllers/admin-service-onboarding.controller';
import { PermissionWebhooksModule } from '../domain/permission-webhooks/permission-webhooks.module';
import { AdminPermissionWebhooksController } from './controllers/admin-permission-webhooks.controller';
import { NotificationModule } from '../notifications/notification.module';
import { AdminNotificationsController } from '../notifications/admin-notifications.controller';
import { AdminSessionModule } from './admin-session.module';

@Module({
  imports: [
    AccountsModule,
    AppConfigModule,
    AdminSessionModule,
    ServiceRegistryModule,
    OidcClientsModule,
    PermissionsModule,
    AccountPermissionsModule,
    AuditLogsModule,
    ServiceCredentialsModule,
    ServiceOnboardingModule,
    PermissionWebhooksModule,
    NotificationModule,
  ],
  controllers: [
    AdminAuthController,
    AdminAccountsController,
    AdminServicesController,
    AdminServiceOnboardingController,
    AdminServiceCredentialScopesController,
    AdminServiceCredentialsController,
    AdminClientsController,
    AdminPermissionDashboardController,
    AdminPermissionsController,
    AdminAuditLogsController,
    AdminPermissionWebhooksController,
    AdminNotificationsController,
  ],
  exports: [AdminSessionModule],
})
export class AdminModule {}
