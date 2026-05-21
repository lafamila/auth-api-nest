import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AccountServicePermissionEntity } from '../../database/entities/account-service-permission.entity';
import { AuditLogEntity } from '../../database/entities/audit-log.entity';
import { ServicePermissionDefinitionEntity } from '../../database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ServiceRegistryService } from '../service-registry/service-registry.service';
import {
  CreatePermissionDto,
  MigratePermissionDto,
  UpdatePermissionDto,
} from './dto/permission.dto';
import { VISITOR_PERMISSION } from './visitor-permission';

@Injectable()
export class PermissionsService {
  constructor(
    @InjectRepository(ServicePermissionDefinitionEntity)
    private readonly permissions: Repository<ServicePermissionDefinitionEntity>,
    @InjectRepository(AccountServicePermissionEntity)
    private readonly accountPermissions: Repository<AccountServicePermissionEntity>,
    private readonly dataSource: DataSource,
    private readonly services: ServiceRegistryService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  list(serviceId: string): Promise<ServicePermissionDefinitionEntity[]> {
    return this.permissions.find({
      where: { serviceId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  async findById(id: string): Promise<ServicePermissionDefinitionEntity> {
    const permission = await this.permissions.findOneBy({ id });
    if (!permission) {
      throw new NotFoundException('Permission not found');
    }
    return permission;
  }

  async findActiveByServiceAndKey(
    serviceId: string,
    key: string,
  ): Promise<ServicePermissionDefinitionEntity | null> {
    return this.permissions.findOneBy({ serviceId, key, status: 'active' });
  }

  async create(
    serviceId: string,
    input: CreatePermissionDto,
  ): Promise<ServicePermissionDefinitionEntity> {
    const service = await this.services.findById(serviceId);
    if (await this.permissions.existsBy({ serviceId, key: input.key })) {
      throw new ConflictException('Permission key already exists for service');
    }
    const permission = await this.permissions.save(
      this.permissions.create({
        service,
        serviceId,
        key: input.key,
        label: input.label,
        description: input.description ?? '',
        status: 'active',
        sortOrder: input.sortOrder ?? 0,
      }),
    );
    await this.services.incrementPermissionSchemaVersion(serviceId);
    await this.auditLogs.record({
      action: 'permission.create',
      targetType: 'service_permission',
      targetId: permission.id,
      afterJson: permission as unknown as Record<string, unknown>,
    });
    return permission;
  }

  async update(
    serviceId: string,
    permissionId: string,
    input: UpdatePermissionDto,
  ): Promise<ServicePermissionDefinitionEntity> {
    const permission = await this.findOwnedPermission(serviceId, permissionId);
    if (
      permission.key === VISITOR_PERMISSION.key &&
      input.status &&
      input.status !== 'active'
    ) {
      throw new BadRequestException('Visitor permission must remain active');
    }
    if (input.status === 'removed') {
      throw new BadRequestException('Use the remove endpoint for removals');
    }
    const before = { ...permission };
    Object.assign(permission, input);
    if (input.status === 'deprecated') {
      permission.deprecatedAt = new Date();
    }
    const saved = await this.permissions.save(permission);
    await this.auditLogs.record({
      action: 'permission.update',
      targetType: 'service_permission',
      targetId: saved.id,
      beforeJson: before,
      afterJson: saved as unknown as Record<string, unknown>,
    });
    return saved;
  }

  deprecate(serviceId: string, permissionId: string) {
    return this.update(serviceId, permissionId, { status: 'deprecated' });
  }

  async migrate(
    serviceId: string,
    permissionId: string,
    input: MigratePermissionDto,
  ): Promise<{ moved: number }> {
    const source = await this.findOwnedPermission(serviceId, permissionId);
    if (source.key === VISITOR_PERMISSION.key) {
      throw new BadRequestException('Visitor permission cannot be migrated or removed');
    }
    const target = await this.findOwnedPermission(serviceId, input.targetPermissionId);
    if (target.status !== 'active') {
      throw new BadRequestException('Migration target must be active');
    }
    if (source.id === target.id) {
      throw new BadRequestException('Migration target must differ from source');
    }

    return this.dataSource.transaction(async (manager) => {
      const result = await manager.update(
        AccountServicePermissionEntity,
        { serviceId, permissionDefinitionId: source.id },
        { permissionDefinitionId: target.id },
      );
      await manager.update(
        ServicePermissionDefinitionEntity,
        { id: source.id },
        { status: 'removed', removedAt: new Date() },
      );
      await manager.increment(ServiceEntity, { id: serviceId }, 'permissionSchemaVersion', 1);
      await manager.save(
        manager.create(AuditLogEntity, {
          action: 'permission.migrate',
          targetType: 'service_permission',
          targetId: source.id,
          beforeJson: { sourcePermissionId: source.id },
          afterJson: { targetPermissionId: target.id, moved: result.affected ?? 0 },
        }),
      );
      return { moved: result.affected ?? 0 };
    });
  }

  async remove(
    serviceId: string,
    permissionId: string,
    input?: MigratePermissionDto,
  ): Promise<{ removed: true; moved?: number }> {
    const assigned = await this.accountPermissions.countBy({
      serviceId,
      permissionDefinitionId: permissionId,
      status: 'active',
    });
    const permission = await this.findOwnedPermission(serviceId, permissionId);
    if (permission.key === VISITOR_PERMISSION.key) {
      throw new BadRequestException('Visitor permission cannot be removed');
    }
    if (assigned > 0) {
      if (!input?.targetPermissionId) {
        throw new BadRequestException('Assigned permission requires migration target');
      }
      const migrated = await this.migrate(serviceId, permissionId, input);
      return { removed: true, moved: migrated.moved };
    }
    permission.status = 'removed';
    permission.removedAt = new Date();
    await this.permissions.save(permission);
    await this.services.incrementPermissionSchemaVersion(serviceId);
    await this.auditLogs.record({
      action: 'permission.remove',
      targetType: 'service_permission',
      targetId: permission.id,
    });
    return { removed: true };
  }

  private async findOwnedPermission(
    serviceId: string,
    permissionId: string,
  ): Promise<ServicePermissionDefinitionEntity> {
    const permission = await this.permissions.findOneBy({ id: permissionId, serviceId });
    if (!permission) {
      throw new NotFoundException('Permission not found');
    }
    return permission;
  }
}
