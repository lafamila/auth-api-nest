import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AdminGuard } from '../admin.guard';
import { ServiceRegistryService } from '../../domain/service-registry/service-registry.service';
import { isServiceCategory } from '../../database/entities/service.entity';

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

  @Patch(':serviceId')
  updateCategory(
    @Param('serviceId') serviceId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: Request & { adminAccount?: { id: string } },
  ) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('A category object is required');
    }
    // This operational exception must not reopen approved core-spec editing.
    if (Object.keys(body).some((key) => key !== 'category')) {
      throw new ForbiddenException(
        'Only category can be changed directly; submit an onboarding update request for core specs',
      );
    }
    if (!isServiceCategory(body.category)) {
      throw new BadRequestException('A supported service category is required');
    }
    return this.services.updateCategory(serviceId, body.category, {
      actorAccountId: request.adminAccount!.id,
      ipAddress: request.ip ?? null,
      userAgent: request.header('user-agent') ?? null,
    });
  }
}
