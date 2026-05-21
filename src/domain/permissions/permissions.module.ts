import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountServicePermissionEntity } from '../../database/entities/account-service-permission.entity';
import { ServicePermissionDefinitionEntity } from '../../database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ServiceRegistryModule } from '../service-registry/service-registry.module';
import { PermissionsService } from './permissions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ServicePermissionDefinitionEntity,
      AccountServicePermissionEntity,
      ServiceEntity,
    ]),
    ServiceRegistryModule,
    AuditLogsModule,
  ],
  providers: [PermissionsService],
  exports: [PermissionsService],
})
export class PermissionsModule {}
