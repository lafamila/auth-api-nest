import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ServicePermissionDefinitionEntity } from '../../database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { VISITOR_PERMISSION } from '../permissions/visitor-permission';
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
    if (await this.services.existsBy({ serviceKey: input.serviceKey })) {
      throw new ConflictException('Service key already exists');
    }
    const service = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(
        manager.create(ServiceEntity, {
          serviceKey: input.serviceKey,
          name: input.name,
          description: input.description ?? '',
          status: 'active',
          permissionSchemaVersion: 1,
        }),
      );
      await manager.save(
        manager.create(ServicePermissionDefinitionEntity, {
          service: saved,
          serviceId: saved.id,
          key: VISITOR_PERMISSION.key,
          label: VISITOR_PERMISSION.label,
          description: VISITOR_PERMISSION.description,
          status: 'active',
          sortOrder: -1000,
        }),
      );
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
    const service = await this.findById(id);
    const before = { ...service };
    Object.assign(service, input);
    const saved = await this.services.save(service);
    await this.auditLogs.record({
      action: 'service.update',
      targetType: 'service',
      targetId: saved.id,
      beforeJson: before,
      afterJson: saved as unknown as Record<string, unknown>,
    });
    return saved;
  }

  async incrementPermissionSchemaVersion(id: string): Promise<ServiceEntity> {
    await this.services.increment({ id }, 'permissionSchemaVersion', 1);
    return this.findById(id);
  }
}
