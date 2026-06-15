import { Body, Controller, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { AccountsService } from '../domain/accounts/accounts.service';
import { CompletePasswordResetDto } from '../domain/accounts/dto/account.dto';
import { LoginDto } from './dto/login.dto';

@Controller()
export class LoginController {
  constructor(private readonly accounts: AccountsService) {}

  @Post('login')
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) response: Response) {
    const account = await this.accounts.authenticate(body.loginId, body.password);
    response.cookie('tas_session', account.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      signed: true,
      maxAge: 12 * 60 * 60 * 1000,
    });
    return {
      account: this.accounts.safeAccount(account),
    };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie('tas_session');
    return { ok: true };
  }

  @Post('password/complete-reset')
  async completePasswordReset(
    @Body() body: CompletePasswordResetDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const account = await this.accounts.completePasswordReset(
      body.loginId,
      body.currentPassword,
      body.newPassword,
    );
    response.cookie('tas_session', account.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      signed: true,
      maxAge: 12 * 60 * 60 * 1000,
    });
    return {
      account: this.accounts.safeAccount(account),
    };
  }
}
