import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ServiceEntity } from '../../database/entities/service.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateServiceDto, UpdateServiceDto } from './dto/service.dto';

@Injectable()
export class ServiceRegistryService {
  constructor(
    @InjectRepository(ServiceEntity)
    private readonly services: Repository<ServiceEntity>,
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
    const service = await this.services.save(
      this.services.create({
        serviceKey: input.serviceKey,
        name: input.name,
        description: input.description ?? '',
        status: 'active',
        permissionSchemaVersion: 1,
      }),
    );
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
    const service = await this.findById(id);
    service.permissionSchemaVersion += 1;
    return this.services.save(service);
  }
}
