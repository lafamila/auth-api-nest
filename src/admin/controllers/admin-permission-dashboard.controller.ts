import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccountPermissionsService } from '../../domain/account-permissions/account-permissions.service';
import { AdminGuard } from '../admin.guard';

@UseGuards(AdminGuard)
@Controller('api/admin/permission-dashboard')
export class AdminPermissionDashboardController {
  constructor(
    private readonly accountPermissions: AccountPermissionsService,
  ) {}

  @Get()
  list() {
    return this.accountPermissions.listDashboardRows();
  }
}
