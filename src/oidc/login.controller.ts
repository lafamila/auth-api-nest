import {
  Body,
  Controller,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Response } from 'express';
import { AccountsService } from '../domain/accounts/accounts.service';
import { CompletePasswordResetDto } from '../domain/accounts/dto/account.dto';
import { AuthorizeFlowService } from './authorize-flow.service';
import { HostedLoginDto } from './dto/hosted-login.dto';
import { OAuthError } from './oauth-error';

@Controller()
export class LoginController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly authorizeFlow: AuthorizeFlowService,
  ) {}

  @Post('oauth/login')
  async hostedLogin(@Body() body: HostedLoginDto, @Res() response: Response) {
    try {
      const validated = await this.authorizeFlow.validateRequest({
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        responseType: body.response_type,
        scope: body.scope,
        state: body.state,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method,
      });
      if (validated.kind === 'redirect') {
        return response.redirect(validated.redirectUrl);
      }
      try {
        const account = await this.accounts.authenticate(body.loginId, body.password);
        this.setSessionCookie(response, account.id);
        const authorizeResult = await this.authorizeFlow.authorizeWithAccount(
          validated,
          account.id,
        );
        return response.redirect(authorizeResult.redirectUrl);
      } catch (error) {
        if (error instanceof UnauthorizedException) {
          return response
            .status(200)
            .type('html')
            .send(
              this.authorizeFlow.renderHostedLoginPage(validated.request, error.message),
            );
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof OAuthError) {
        return response.status(error.statusCode).json({
          error: error.error,
          error_description: error.errorDescription,
        });
      }
      throw error;
    }
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
    this.setSessionCookie(response, account.id);
    return {
      account: this.accounts.safeAccount(account),
    };
  }

  private setSessionCookie(response: Response, accountId: string) {
    response.cookie('tas_session', accountId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      signed: true,
      maxAge: 12 * 60 * 60 * 1000,
    });
  }
}
