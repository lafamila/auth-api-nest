import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ServicePermissionDefinitionEntity } from '../../database/entities/service-permission-definition.entity';
import {
  isServiceCategory,
  ServiceCategory,
  ServiceEntity,
} from '../../database/entities/service.entity';
import { AuditInput, AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  SUPERADMIN_PERMISSION,
  VISITOR_PERMISSION,
} from '../permissions/managed-permissions';
import { CreateServiceDto, UpdateServiceDto } from './dto/service.dto';

@Injectable()
export class ServiceRegistryService {
  constructor(
    @InjectRepository(ServiceEntity)
    private readonly services: Repository<ServiceEntity>,
    private readonly dataSource: DataSource,
    private readonly auditLogs: AuditLogsService,
  ) {}

  list(): Promise<ServiceEntity[]> {
    return this.services.find({ order: { createdAt: 'DESC' } });
  }

  async findById(id: string): Promise<ServiceEntity> {
    const service = await this.services.findOneBy({ id });
    if (!service) {
      throw new NotFoundException('Service not found');
    }
    return service;
  }

  findByKey(serviceKey: string): Promise<ServiceEntity | null> {
    return this.services.findOneBy({ serviceKey });
  }

  async create(input: CreateServiceDto): Promise<ServiceEntity> {
    this.assertCategory(input.category);
    if (await this.services.existsBy({ serviceKey: input.serviceKey })) {
      throw new ConflictException('Service key already exists');
    }
    const service = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(
        manager.create(ServiceEntity, {
          serviceKey: input.serviceKey,
          name: input.name,
          description: input.description ?? '',
          category: input.category ?? 'other',
          status: 'active',
          permissionSchemaVersion: 1,
        }),
      );
      await manager.save([
        manager.create(ServicePermissionDefinitionEntity, {
          service: saved,
          serviceId: saved.id,
          key: SUPERADMIN_PERMISSION.key,
          label: SUPERADMIN_PERMISSION.label,
          description: SUPERADMIN_PERMISSION.description,
          status: 'active',
          sortOrder: SUPERADMIN_PERMISSION.sortOrder,
        }),
        manager.create(ServicePermissionDefinitionEntity, {
          service: saved,
          serviceId: saved.id,
          key: VISITOR_PERMISSION.key,
          label: VISITOR_PERMISSION.label,
          description: VISITOR_PERMISSION.description,
          status: 'active',
          sortOrder: -1000,
        }),
      ]);
      return saved;
    });
    await this.auditLogs.record({
      action: 'service.create',
      targetType: 'service',
      targetId: service.id,
      afterJson: service as unknown as Record<string, unknown>,
    });
    return service;
  }

  async update(id: string, input: UpdateServiceDto): Promise<ServiceEntity> {
    this.assertCategory(input.category);
    const service = await this.findById(id);
    const before = { ...service };
    // Only write submitted fields so an omitted category cannot undo an admin edit.
    if (Object.values(input).some((value) => value !== undefined)) {
      await this.services.update(id, input);
    }
    const saved = await this.findById(id);
    await this.auditLogs.record({
      action: 'service.update',
      targetType: 'service',
      targetId: saved.id,
      beforeJson: before,
      afterJson: saved as unknown as Record<string, unknown>,
    });
    return saved;
  }

  async updateCategory(
    id: string,
    category: ServiceCategory,
    actor: Pick<AuditInput, 'actorAccountId' | 'ipAddress' | 'userAgent'>,
  ): Promise<ServiceEntity> {
    if (!isServiceCategory(category)) {
      throw new BadRequestException('Unsupported service category');
    }
    return this.dataSource.transaction(async (manager) => {
      const service = await manager.findOne(ServiceEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!service) throw new NotFoundException('Service not found');
      const before = service.category;
      await manager.update(ServiceEntity, id, { category });
      await this.auditLogs.record(
        {
          ...actor,
          action: 'service.category.update',
          targetType: 'service',
          targetId: id,
          beforeJson: { category: before },
          afterJson: { category },
        },
        manager,
      );
      return manager.findOneByOrFail(ServiceEntity, { id });
    });
  }

  private assertCategory(category: unknown): void {
    if (category !== undefined && !isServiceCategory(category)) {
      throw new BadRequestException('Unsupported service category');
    }
  }

  async incrementPermissionSchemaVersion(id: string): Promise<ServiceEntity> {
    await this.services.increment({ id }, 'permissionSchemaVersion', 1);
    return this.findById(id);
  }
}
