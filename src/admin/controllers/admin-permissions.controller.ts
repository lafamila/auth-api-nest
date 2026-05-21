import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import {
  CreatePermissionDto,
  MigratePermissionDto,
  UpdatePermissionDto,
} from '../../domain/permissions/dto/permission.dto';
import { PermissionsService } from '../../domain/permissions/permissions.service';

@UseGuards(AdminGuard)
@Controller('api/admin/services/:serviceId/permissions')
export class AdminPermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Post()
  create(
    @Param('serviceId') serviceId: string,
    @Body() body: CreatePermissionDto,
  ) {
    return this.permissions.create(serviceId, body);
  }

  @Get()
  list(@Param('serviceId') serviceId: string) {
    return this.permissions.list(serviceId);
  }

  @Patch(':permissionId')
  update(
    @Param('serviceId') serviceId: string,
    @Param('permissionId') permissionId: string,
    @Body() body: UpdatePermissionDto,
  ) {
    return this.permissions.update(serviceId, permissionId, body);
  }

  @Post(':permissionId/deprecate')
  deprecate(
    @Param('serviceId') serviceId: string,
    @Param('permissionId') permissionId: string,
  ) {
    return this.permissions.deprecate(serviceId, permissionId);
  }

  @Post(':permissionId/migrate')
  migrate(
    @Param('serviceId') serviceId: string,
    @Param('permissionId') permissionId: string,
    @Body() body: MigratePermissionDto,
  ) {
    return this.permissions.migrate(serviceId, permissionId, body);
  }

  @Post(':permissionId/remove')
  remove(
    @Param('serviceId') serviceId: string,
    @Param('permissionId') permissionId: string,
    @Body() body: Partial<MigratePermissionDto>,
  ) {
    return this.permissions.remove(
      serviceId,
      permissionId,
      body.targetPermissionId ? { targetPermissionId: body.targetPermissionId } : undefined,
    );
  }
}
