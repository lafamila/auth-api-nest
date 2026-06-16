import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
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
    private readonly config: AppConfigService,
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
    this.clearSessionCookie(response);
    return { ok: true };
  }

  @Get('logout')
  logoutPage(
    @Query('return_to') returnTo: string | undefined,
    @Res() response: Response,
  ) {
    this.clearSessionCookie(response);
    const safeReturnTo = this.safeReturnTo(returnTo);
    if (safeReturnTo) {
      return response.redirect(safeReturnTo);
    }
    return response
      .status(200)
      .type('html')
      .send(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>로그아웃</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: system-ui, sans-serif;
        background: #f4f4f4;
      }
      main {
        width: min(320px, calc(100vw - 32px));
        display: grid;
        gap: 12px;
      }
      p {
        margin: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <p>로그아웃되었습니다.</p>
    </main>
  </body>
</html>`);
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

  private clearSessionCookie(response: Response) {
    response.clearCookie('tas_session', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    });
  }

  private safeReturnTo(returnTo: string | undefined): string | undefined {
    if (!returnTo) {
      return undefined;
    }
    let parsed: URL;
    try {
      parsed = new URL(returnTo);
    } catch {
      return undefined;
    }
    const allowedOrigins = new Set([
      new URL(this.config.issuerUrl).origin,
      ...this.config.corsOrigins.map((origin) => new URL(origin).origin),
    ]);
    if (!allowedOrigins.has(parsed.origin)) {
      return undefined;
    }
    return parsed.toString();
  }
}
