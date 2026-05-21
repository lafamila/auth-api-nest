import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminGuard } from '../../admin/admin.guard';
import { AppConfigModule } from '../../config/app-config.module';
import { AccountServicePermissionEntity } from '../../database/entities/account-service-permission.entity';
import { AccountEntity } from '../../database/entities/account.entity';
import { ServiceApplicationEntity } from '../../database/entities/service-application.entity';
import { ServicePermissionDefinitionEntity } from '../../database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { OidcModule } from '../../oidc/oidc.module';
import { ServiceApplicationsController } from './service-applications.controller';
import { ServiceApplicationsService } from './service-applications.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AccountEntity,
      ServiceEntity,
      ServicePermissionDefinitionEntity,
      AccountServicePermissionEntity,
      ServiceApplicationEntity,
    ]),
    AppConfigModule,
    AuditLogsModule,
    OidcModule,
  ],
  controllers: [ServiceApplicationsController],
  providers: [ServiceApplicationsService, AdminGuard],
  exports: [ServiceApplicationsService],
})
export class ServiceApplicationsModule {}
