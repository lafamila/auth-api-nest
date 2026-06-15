import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import { PermissionsService } from '../../domain/permissions/permissions.service';

@UseGuards(AdminGuard)
@Controller('api/admin/services/:serviceId/permissions')
export class AdminPermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get()
  list(@Param('serviceId') serviceId: string) {
    return this.permissions.list(serviceId);
  }
}
