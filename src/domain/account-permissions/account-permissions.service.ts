import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { AccountServicePermissionEntity } from '../../database/entities/account-service-permission.entity';
import { AccountsService } from '../accounts/accounts.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import { ServiceRegistryService } from '../service-registry/service-registry.service';
import {
  PermissionDashboardPageDto,
  PermissionDashboardQueryDto,
  PermissionDashboardRowDto,
} from './dto/permission-dashboard.dto';

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

  async listDashboardRows(
    query: PermissionDashboardQueryDto,
  ): Promise<PermissionDashboardPageDto> {
    const pageSize = Math.min(
      Math.max(Number(query.pageSize) || 25, 1),
      100,
    );
    const requestedPage = Math.max(Number(query.page) || 1, 1);
    const where: FindOptionsWhere<AccountServicePermissionEntity> = {
      status: 'active',
      account: { status: 'active' },
      ...(query.serviceKey ? { service: { serviceKey: query.serviceKey } } : {}),
    };
    const total = await this.accountPermissions.count({ where });
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
    const rows = await this.accountPermissions.find({
      where,
      order: {
        grantedAt: 'DESC',
        createdAt: 'DESC',
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: rows.map((row) => this.toDashboardRow(row)),
      page,
      pageSize,
      total,
      totalPages,
    };
  }

  private toDashboardRow(
    row: AccountServicePermissionEntity,
  ): PermissionDashboardRowDto {
    return {
      id: row.id,
      accountId: row.accountId,
      loginId: row.account.loginId,
      accountName: row.account.name,
      email: row.account.email,
      serviceId: row.serviceId,
      serviceKey: row.service.serviceKey,
      serviceName: row.service.name,
      permissionDefinitionId: row.permissionDefinitionId,
      permissionKey: row.permissionDefinition.key,
      permissionLabel: row.permissionDefinition.label,
      permissionStatus: row.permissionDefinition.status,
      grantedAt: row.grantedAt,
      grantedByAccountId: row.grantedByAccountId,
    };
  }
}
