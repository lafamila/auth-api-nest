import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import { AccountsService } from '../../domain/accounts/accounts.service';
import { ResetPasswordDto, UpdateAccountDto } from '../../domain/accounts/dto/account.dto';

@UseGuards(AdminGuard)
@Controller('api/admin/accounts')
export class AdminAccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list() {
    return this.accounts.list();
  }

  @Get('service-search')
  searchForService(
    @Query('serviceKey') serviceKey: string,
    @Query('q') q?: string,
  ) {
    return this.accounts.searchForService(serviceKey, q ?? '');
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
}
