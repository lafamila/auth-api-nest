import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountServicePermissionEntity } from '../../database/entities/account-service-permission.entity';
import { AccountsModule } from '../accounts/accounts.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { ServiceRegistryModule } from '../service-registry/service-registry.module';
import { AccountPermissionsService } from './account-permissions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([AccountServicePermissionEntity]),
    AccountsModule,
    ServiceRegistryModule,
    PermissionsModule,
    AuditLogsModule,
  ],
  providers: [AccountPermissionsService],
  exports: [AccountPermissionsService],
})
export class AccountPermissionsModule {}
