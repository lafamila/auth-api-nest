import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import {
  CreatePermissionDto,
  MigratePermissionDto,
  UpdatePermissionDto,
} from '../../domain/permissions/dto/permission.dto';
import { PermissionsService } from '../../domain/permissions/permissions.service';
import { ServiceOnboardingService } from '../../domain/service-onboarding/service-onboarding.service';

@UseGuards(AdminGuard)
@Controller('api/admin/services/:serviceId/permissions')
export class AdminPermissionsController {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly onboarding: ServiceOnboardingService,
  ) {}

  @Post()
  async create(
    @Param('serviceId') serviceId: string,
    @Body() body: CreatePermissionDto,
  ) {
    await this.onboarding.assertManualCoreSpecEditAllowed(serviceId);
    return this.permissions.create(serviceId, body);
  }

  @Get()
  list(@Param('serviceId') serviceId: string) {
    return this.permissions.list(serviceId);
  }

  @Patch(':permissionId')
  async update(
    @Param('serviceId') serviceId: string,
    @Param('permissionId') permissionId: string,
    @Body() body: UpdatePermissionDto,
  ) {
    if (body.status !== undefined) {
      await this.onboarding.assertManualCoreSpecEditAllowed(serviceId);
    }
    return this.permissions.update(serviceId, permissionId, body);
  }

  @Post(':permissionId/deprecate')
  async deprecate(
    @Param('serviceId') serviceId: string,
    @Param('permissionId') permissionId: string,
  ) {
    await this.onboarding.assertManualCoreSpecEditAllowed(serviceId);
    return this.permissions.deprecate(serviceId, permissionId);
  }

  @Post(':permissionId/migrate')
  async migrate(
    @Param('serviceId') serviceId: string,
    @Param('permissionId') permissionId: string,
    @Body() body: MigratePermissionDto,
  ) {
    await this.onboarding.assertManualCoreSpecEditAllowed(serviceId);
    return this.permissions.migrate(serviceId, permissionId, body);
  }

  @Post(':permissionId/remove')
  async remove(
    @Param('serviceId') serviceId: string,
    @Param('permissionId') permissionId: string,
    @Body() body: Partial<MigratePermissionDto>,
  ) {
    await this.onboarding.assertManualCoreSpecEditAllowed(serviceId);
    return this.permissions.remove(
      serviceId,
      permissionId,
      body.targetPermissionId ? { targetPermissionId: body.targetPermissionId } : undefined,
    );
  }
}
