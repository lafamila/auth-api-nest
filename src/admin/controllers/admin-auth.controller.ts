import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AdminAuthService } from '../admin-auth.service';
import { AdminGuard } from '../admin.guard';
import {
  AdminLoginDto,
  BootstrapCompleteDto,
  BootstrapStartDto,
} from '../dto/admin-auth.dto';

@Controller('api/admin')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Get('bootstrap/status')
  bootstrapStatus() {
    return this.adminAuth.bootstrapStatus();
  }

  @Post('bootstrap/start')
  startBootstrap(@Body() body: BootstrapStartDto) {
    return this.adminAuth.startBootstrap(body);
  }

  @Post('bootstrap/complete')
  completeBootstrap(@Body() body: BootstrapCompleteDto) {
    return this.adminAuth.completeBootstrap(body);
  }

  @Post('login')
  login(
    @Body() body: AdminLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.adminAuth.login(body, request, response);
  }

  @UseGuards(AdminGuard)
  @Get('session')
  session(@Req() request: Request & { adminAccount?: unknown }) {
    return { account: request.adminAccount };
  }

  @UseGuards(AdminGuard)
  @Post('logout')
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.adminAuth.logout(request, response);
    return { ok: true };
  }
}
