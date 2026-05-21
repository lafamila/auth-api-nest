import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
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
    OidcModule,
    ServiceApplicationsModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      serveRoot: '/admin',
      exclude: ['/api/*', '/oauth/*', '/oidc/*', '/.well-known/*'],
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
