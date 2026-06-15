import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import { TotpService } from '../common/crypto/totp.service';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { AccountPermissionsModule } from '../domain/account-permissions/account-permissions.module';
import { AppConfigModule } from '../config/app-config.module';
import { AuditLogsModule } from '../domain/audit-logs/audit-logs.module';
import { OidcClientsModule } from '../domain/oidc-clients/oidc-clients.module';
import { PermissionsModule } from '../domain/permissions/permissions.module';
import { ServiceRegistryModule } from '../domain/service-registry/service-registry.module';
import { ServiceCredentialsModule } from '../domain/service-credentials/service-credentials.module';
import { ServiceOnboardingModule } from '../domain/service-onboarding/service-onboarding.module';
import { AdminBootstrapChallengeEntity } from '../database/entities/admin-bootstrap-challenge.entity';
import { AdminMfaEntity } from '../database/entities/admin-mfa.entity';
import { AdminSessionEntity } from '../database/entities/admin-session.entity';
import { AdminAuthService } from './admin-auth.service';
import { AdminAuthController } from './controllers/admin-auth.controller';
import { AdminAccountsController } from './controllers/admin-accounts.controller';
import { AdminAuditLogsController } from './controllers/admin-audit-logs.controller';
import { AdminClientsController } from './controllers/admin-clients.controller';
import { AdminPermissionDashboardController } from './controllers/admin-permission-dashboard.controller';
import { AdminPermissionsController } from './controllers/admin-permissions.controller';
import { AdminServiceCredentialsController } from './controllers/admin-service-credentials.controller';
import { AdminServicesController } from './controllers/admin-services.controller';
import { AdminServiceOnboardingController } from './controllers/admin-service-onboarding.controller';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [
    AccountsModule,
    AppConfigModule,
    TypeOrmModule.forFeature([
      AdminBootstrapChallengeEntity,
      AdminMfaEntity,
      AdminSessionEntity,
    ]),
    ServiceRegistryModule,
    OidcClientsModule,
    PermissionsModule,
    AccountPermissionsModule,
    AuditLogsModule,
    ServiceCredentialsModule,
    ServiceOnboardingModule,
  ],
  controllers: [
    AdminAuthController,
    AdminAccountsController,
    AdminServicesController,
    AdminServiceOnboardingController,
    AdminServiceCredentialsController,
    AdminClientsController,
    AdminPermissionDashboardController,
    AdminPermissionsController,
    AdminAuditLogsController,
  ],
  providers: [AdminGuard, AdminAuthService, AesGcmService, TotpService],
  exports: [AdminGuard, AdminAuthService],
})
export class AdminModule {}
