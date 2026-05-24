import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountServicePermissionEntity } from '../../database/entities/account-service-permission.entity';
import { AccountsService } from '../accounts/accounts.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import { ServiceRegistryService } from '../service-registry/service-registry.service';
import { PermissionDashboardRowDto } from './dto/permission-dashboard.dto';

@Injectable()
export class AccountPermissionsService {
  constructor(
    @InjectRepository(AccountServicePermissionEntity)
    private readonly accountPermissions: Repository<AccountServicePermissionEntity>,
    private readonly accounts: AccountsService,
    private readonly services: ServiceRegistryService,
    private readonly permissions: PermissionsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async put(
    accountId: string,
    serviceId: string,
    permissionDefinitionId: string,
    grantedByAccountId?: string | null,
  ): Promise<AccountServicePermissionEntity> {
    const account = await this.accounts.findById(accountId);
    const service = await this.services.findById(serviceId);
    const permission = await this.permissions.findById(permissionDefinitionId);
    if (permission.serviceId !== serviceId || permission.status !== 'active') {
      throw new BadRequestException('Permission must be active and belong to service');
    }
    const existing = await this.accountPermissions.findOneBy({ accountId, serviceId });
    const entity =
      existing ??
      this.accountPermissions.create({
        account,
        accountId,
        service,
        serviceId,
        grantedAt: new Date(),
      });
    entity.permissionDefinition = permission;
    entity.permissionDefinitionId = permission.id;
    entity.status = 'active';
    entity.revokedAt = null;
    entity.grantedByAccountId = grantedByAccountId ?? null;
    const saved = await this.accountPermissions.save(entity);
    await this.auditLogs.record({
      actorAccountId: grantedByAccountId,
      action: 'account_permission.put',
      targetType: 'account_service_permission',
      targetId: saved.id,
      afterJson: {
        accountId,
        serviceId,
        permissionDefinitionId,
      },
    });
    return saved;
  }

  async revoke(accountId: string, serviceId: string): Promise<void> {
    const permission = await this.accountPermissions.findOneBy({ accountId, serviceId });
    if (!permission) {
      throw new NotFoundException('Account service permission not found');
    }
    permission.status = 'revoked';
    permission.revokedAt = new Date();
    await this.accountPermissions.save(permission);
    await this.auditLogs.record({
      action: 'account_permission.revoke',
      targetType: 'account_service_permission',
      targetId: permission.id,
    });
  }

  async findActive(
    accountId: string,
    serviceId: string,
  ): Promise<AccountServicePermissionEntity | null> {
    return this.accountPermissions.findOne({
      where: { accountId, serviceId, status: 'active' },
    });
  }

  async listDashboardRows(): Promise<PermissionDashboardRowDto[]> {
    const rows = await this.accountPermissions.find({
      order: {
        grantedAt: 'DESC',
        createdAt: 'DESC',
      },
    });
    return rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      loginId: row.account.loginId,
      accountName: row.account.name,
      email: row.account.email,
      accountStatus: row.account.status,
      isSuperAdmin: row.account.isSuperAdmin,
      serviceId: row.serviceId,
      serviceKey: row.service.serviceKey,
      serviceName: row.service.name,
      serviceStatus: row.service.status,
      permissionDefinitionId: row.permissionDefinitionId,
      permissionKey: row.permissionDefinition.key,
      permissionLabel: row.permissionDefinition.label,
      permissionStatus: row.permissionDefinition.status,
      assignmentStatus: row.status,
      grantedAt: row.grantedAt,
      revokedAt: row.revokedAt,
      grantedByAccountId: row.grantedByAccountId,
    }));
  }
}
