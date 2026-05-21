import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import { AccountsService } from '../../domain/accounts/accounts.service';
import {
  CreateAccountDto,
  ResetPasswordDto,
  UpdateAccountDto,
} from '../../domain/accounts/dto/account.dto';
import { AccountPermissionsService } from '../../domain/account-permissions/account-permissions.service';
import { PutAccountPermissionDto } from '../../domain/account-permissions/dto/account-permission.dto';

@UseGuards(AdminGuard)
@Controller('api/admin/accounts')
export class AdminAccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly accountPermissions: AccountPermissionsService,
  ) {}

  @Post()
  create(@Body() body: CreateAccountDto) {
    return this.accounts.create(body);
  }

  @Get()
  list() {
    return this.accounts.list();
  }

  @Get(':accountId')
  get(@Param('accountId') accountId: string) {
    return this.accounts.findById(accountId);
  }

  @Patch(':accountId')
  update(@Param('accountId') accountId: string, @Body() body: UpdateAccountDto) {
    return this.accounts.update(accountId, body);
  }

  @Post(':accountId/reset-password')
  async resetPassword(
    @Param('accountId') accountId: string,
    @Body() body: ResetPasswordDto,
  ) {
    await this.accounts.resetPassword(accountId, body.password);
    return { ok: true };
  }

  @Put(':accountId/services/:serviceId/permission')
  putPermission(
    @Param('accountId') accountId: string,
    @Param('serviceId') serviceId: string,
    @Body() body: PutAccountPermissionDto,
  ) {
    return this.accountPermissions.put(
      accountId,
      serviceId,
      body.permissionDefinitionId,
    );
  }

  @Delete(':accountId/services/:serviceId/permission')
  async revokePermission(
    @Param('accountId') accountId: string,
    @Param('serviceId') serviceId: string,
  ) {
    await this.accountPermissions.revoke(accountId, serviceId);
    return { ok: true };
  }
}
