import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { OidcClientEntity } from '../../database/entities/oidc-client.entity';
import { ServicePermissionDefinitionEntity } from '../../database/entities/service-permission-definition.entity';
import { ServiceOnboardingRequestEntity } from '../../database/entities/service-onboarding-request.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { OidcClientsModule } from '../oidc-clients/oidc-clients.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { ServiceCredentialsModule } from '../service-credentials/service-credentials.module';
import { ServiceRegistryModule } from '../service-registry/service-registry.module';
import { ServiceOnboardingController } from './service-onboarding.controller';
import { ServiceOnboardingService } from './service-onboarding.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ServiceOnboardingRequestEntity,
      ServicePermissionDefinitionEntity,
      OidcClientEntity,
    ]),
    ServiceRegistryModule,
    PermissionsModule,
    OidcClientsModule,
    ServiceCredentialsModule,
    AuditLogsModule,
  ],
  controllers: [ServiceOnboardingController],
  providers: [ServiceOnboardingService, PasswordService],
  exports: [ServiceOnboardingService],
})
export class ServiceOnboardingModule {}
