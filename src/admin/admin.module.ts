import { Module } from '@nestjs/common';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { AccountPermissionsModule } from '../domain/account-permissions/account-permissions.module';
import { AppConfigModule } from '../config/app-config.module';
import { AuditLogsModule } from '../domain/audit-logs/audit-logs.module';
import { OidcClientsModule } from '../domain/oidc-clients/oidc-clients.module';
import { PermissionsModule } from '../domain/permissions/permissions.module';
import { ServiceRegistryModule } from '../domain/service-registry/service-registry.module';
import { AdminAccountsController } from './controllers/admin-accounts.controller';
import { AdminAuditLogsController } from './controllers/admin-audit-logs.controller';
import { AdminClientsController } from './controllers/admin-clients.controller';
import { AdminPermissionsController } from './controllers/admin-permissions.controller';
import { AdminServicesController } from './controllers/admin-services.controller';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [
    AccountsModule,
    AppConfigModule,
    ServiceRegistryModule,
    OidcClientsModule,
    PermissionsModule,
    AccountPermissionsModule,
    AuditLogsModule,
  ],
  controllers: [
    AdminAccountsController,
    AdminServicesController,
    AdminClientsController,
    AdminPermissionsController,
    AdminAuditLogsController,
  ],
  providers: [AdminGuard],
})
export class AdminModule {}
