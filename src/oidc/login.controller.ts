import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { AccountsService } from '../domain/accounts/accounts.service';
import { CompletePasswordResetDto } from '../domain/accounts/dto/account.dto';
import {
  AuthorizeFlowService,
  SELECT_ACCOUNT_PROMPT,
  ValidatedAuthorizeRequest,
} from './authorize-flow.service';
import { HostedLoginDto } from './dto/hosted-login.dto';
import {
  HostedLoginTransaction,
  HostedLoginTransactionService,
} from './hosted-login-transaction.service';
import { OAuthError } from './oauth-error';

type SignedCookieRequest = Request & {
  signedCookies?: Record<string, string | undefined>;
};

@Controller()
export class LoginController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly authorizeFlow: AuthorizeFlowService,
    private readonly config: AppConfigService,
    private readonly hostedLoginTransactions: HostedLoginTransactionService,
  ) {}

  @Post('oauth/login')
  async hostedLogin(
    @Body() body: HostedLoginDto,
    @Req()
    request: SignedCookieRequest,
    @Res() response: Response,
  ) {
    try {
      const loaded = await this.loadHostedLoginTransaction(
        body.login_transaction,
        request,
      );
      const validated = await this.authorizeFlow.validateRequest(
        loaded.transaction.request,
      );
      if (validated.kind === 'redirect') {
        return response.redirect(validated.redirectUrl);
      }
      const currentSession = request.signedCookies?.tas_session ?? null;
      if (loaded.transaction.sessionAccountId !== currentSession) {
        throw new BadRequestException(
          'Login session changed during authorization',
        );
      }
      if (validated.request.prompt === SELECT_ACCOUNT_PROMPT) {
        return this.completeAccountSelection(
          body,
          validated,
          loaded.transaction,
          body.login_transaction,
          loaded.browserNonce,
          response,
        );
      }
      try {
        if (!body.loginId || !body.password || body.account_selection) {
          throw new BadRequestException(
            'Hosted login credentials are required',
          );
        }
        const account = await this.accounts.authenticate(
          body.loginId,
          body.password,
        );
        await this.consumeHostedLoginTransaction(
          body.login_transaction,
          loaded.browserNonce,
          response,
        );
        this.setSessionCookie(response, account.id);
        const authorizeResult = await this.authorizeFlow.authorizeWithAccount(
          validated,
          account.id,
        );
        return response.redirect(authorizeResult.redirectUrl);
      } catch (error) {
        if (error instanceof UnauthorizedException) {
          this.setHostedPageSecurityHeaders(response);
          return response
            .status(200)
            .type('html')
            .send(
              this.authorizeFlow.renderHostedLoginPage(
                validated.request,
                body.login_transaction,
                error.message,
              ),
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

  private async completeAccountSelection(
    body: HostedLoginDto,
    validated: ValidatedAuthorizeRequest,
    transaction: HostedLoginTransaction,
    transactionId: string,
    browserNonce: string,
    response: Response,
  ) {
    if (!body.account_selection) {
      throw new BadRequestException('Account selection is required');
    }

    try {
      const account =
        body.account_selection === 'current'
          ? transaction.sessionAccountId
            ? await this.accounts.findById(transaction.sessionAccountId)
            : (() => {
                throw new UnauthorizedException(
                  'Current session is unavailable',
                );
              })()
          : await this.accounts.authenticate(body.loginId!, body.password!);
      await this.consumeHostedLoginTransaction(
        transactionId,
        browserNonce,
        response,
      );
      const authorizeResult = await this.authorizeFlow.authorizeWithAccount(
        validated,
        account.id,
      );
      return response.redirect(authorizeResult.redirectUrl);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        const currentAccount = transaction.sessionAccountId
          ? await this.accounts.findById(transaction.sessionAccountId)
          : undefined;
        this.setHostedPageSecurityHeaders(response);
        return response
          .status(200)
          .type('html')
          .send(
            this.authorizeFlow.renderAccountSelectionPage(
              validated.request,
              transactionId,
              currentAccount,
              error.message,
            ),
          );
      }
      throw error;
    }
  }

  private async loadHostedLoginTransaction(
    transactionId: string,
    request: SignedCookieRequest,
  ): Promise<{
    transaction: HostedLoginTransaction;
    browserNonce: string;
  }> {
    const cookieName = this.hostedLoginTransactions.cookieName(transactionId);
    const browserNonce = request.signedCookies?.[cookieName];
    if (typeof browserNonce !== 'string') {
      throw new BadRequestException('Invalid or expired login transaction');
    }
    const transaction = await this.hostedLoginTransactions.find(
      transactionId,
      browserNonce,
    );
    if (!transaction) {
      throw new BadRequestException('Invalid or expired login transaction');
    }
    return { transaction, browserNonce };
  }

  private async consumeHostedLoginTransaction(
    transactionId: string,
    browserNonce: string,
    response: Response,
  ): Promise<void> {
    const consumed = await this.hostedLoginTransactions.consume(
      transactionId,
      browserNonce,
    );
    if (!consumed) {
      throw new BadRequestException('Invalid or expired login transaction');
    }
    this.clearHostedLoginTransactionCookie(response, transactionId);
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
    return response.status(200).type('html').send(`<!doctype html>
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

  private clearHostedLoginTransactionCookie(
    response: Response,
    transactionId: string,
  ) {
    response.clearCookie(
      this.hostedLoginTransactions.cookieName(transactionId),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/oauth/login',
      },
    );
  }

  private setHostedPageSecurityHeaders(response: Response) {
    response.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
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
