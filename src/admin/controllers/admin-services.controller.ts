import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import { ServiceRegistryService } from '../../domain/service-registry/service-registry.service';

@UseGuards(AdminGuard)
@Controller('api/admin/services')
export class AdminServicesController {
  constructor(private readonly services: ServiceRegistryService) {}

  @Get()
  list() {
    return this.services.list();
  }

  @Get(':serviceId')
  get(@Param('serviceId') serviceId: string) {
    return this.services.findById(serviceId);
  }
}
