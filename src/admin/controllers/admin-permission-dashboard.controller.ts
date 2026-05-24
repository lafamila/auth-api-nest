import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AccountPermissionsService } from '../../domain/account-permissions/account-permissions.service';
import { PermissionDashboardQueryDto } from '../../domain/account-permissions/dto/permission-dashboard.dto';
import { AdminGuard } from '../admin.guard';

@UseGuards(AdminGuard)
@Controller('api/admin/permission-dashboard')
export class AdminPermissionDashboardController {
  constructor(
    private readonly accountPermissions: AccountPermissionsService,
  ) {}

  @Get()
  list(@Query() query: PermissionDashboardQueryDto) {
    return this.accountPermissions.listDashboardRows(query);
  }
}
