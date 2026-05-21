import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import {
  CreateServiceDto,
  UpdateServiceDto,
} from '../../domain/service-registry/dto/service.dto';
import { ServiceRegistryService } from '../../domain/service-registry/service-registry.service';

@UseGuards(AdminGuard)
@Controller('api/admin/services')
export class AdminServicesController {
  constructor(private readonly services: ServiceRegistryService) {}

  @Post()
  create(@Body() body: CreateServiceDto) {
    return this.services.create(body);
  }

  @Get()
  list() {
    return this.services.list();
  }

  @Get(':serviceId')
  get(@Param('serviceId') serviceId: string) {
    return this.services.findById(serviceId);
  }

  @Patch(':serviceId')
  update(@Param('serviceId') serviceId: string, @Body() body: UpdateServiceDto) {
    return this.services.update(serviceId, body);
  }
}
