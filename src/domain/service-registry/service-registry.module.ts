import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServiceEntity } from '../../database/entities/service.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ServiceRegistryService } from './service-registry.service';
import { ServiceCategoriesController } from './service-categories.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ServiceEntity]), AuditLogsModule],
  providers: [ServiceRegistryService],
  controllers: [ServiceCategoriesController],
  exports: [ServiceRegistryService],
})
export class ServiceRegistryModule {}
