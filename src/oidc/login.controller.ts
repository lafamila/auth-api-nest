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
import { PortalAuthService } from '../portal/portal-auth.service';
import { SsoSessionService } from './sso-session.service';
import { AccountEntity } from '../database/entities/account.entity';

type SignedCookieRequest = Request & {
  signedCookies?: Record<string, string | undefined>;
};

const HOSTED_LOGIN_SCRIPT = `(() => {
  const forms = [...document.querySelectorAll('form[action="/oauth/login"], form[data-social-login], form[data-single-submit]')];
  let submitting = false;
  for (const form of forms) {
    form.addEventListener('submit', (event) => {
      if (submitting) {
        event.preventDefault();
        return;
      }
      submitting = true;
      document.documentElement.setAttribute('aria-busy', 'true');
      for (const button of document.querySelectorAll('button[type="submit"]')) {
        button.disabled = true;
      }
      const submitter = event.submitter instanceof HTMLButtonElement
        ? event.submitter
        : form.querySelector('button[type="submit"]');
      if (submitter) {
        submitter.textContent = '처리 중';
        submitter.setAttribute('aria-busy', 'true');
      }
    });
  }
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  });
})();`;

@Controller()
export class LoginController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly authorizeFlow: AuthorizeFlowService,
    private readonly config: AppConfigService,
    private readonly hostedLoginTransactions: HostedLoginTransactionService,
    private readonly portal: PortalAuthService,
    private readonly sso: SsoSessionService,
  ) {}

  @Get('oauth/hosted-login.js')
  hostedLoginScript(@Res() response: Response) {
    response.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    return response.status(200).send(HOSTED_LOGIN_SCRIPT);
  }

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
      if (!loaded.transaction.request) {
        if (
          loaded.transaction.purpose !== 'portal' ||
          loaded.transaction.sessionAccountId !==
            (await this.sso.accountId(request))
        ) {
          throw new BadRequestException(
            'Login session changed during authorization',
          );
        }
        if (!body.loginId || !body.password || body.account_selection)
          throw new BadRequestException(
            'Hosted login credentials are required',
          );
        let account: AccountEntity;
        try {
          account = await this.accounts.authenticate(
            body.loginId,
            body.password,
          );
          if (
            loaded.transaction.expectedAccountId &&
            loaded.transaction.expectedAccountId !== account.id
          ) {
            throw new UnauthorizedException('같은 계정으로 다시 인증해 주세요');
          }
        } catch (error) {
          if (!(error instanceof UnauthorizedException)) throw error;
          this.setHostedPageSecurityHeaders(response, this.config.issuerUrl);
          return response
            .status(200)
            .type('html')
            .send(
              this.authorizeFlow.renderHostedLoginPage(
                null,
                body.login_transaction,
                error.message,
              ),
            );
        }
        await this.consumeHostedLoginTransaction(
          body.login_transaction,
          loaded.browserNonce,
          response,
        );
        const target = await this.portal.completePrimary(
          account,
          request,
          response,
          loaded.transaction.expectedAccountId,
        );
        return this.sendAuthorizationRedirect(
          response,
          new URL(target, this.config.issuerUrl).toString(),
        );
      }
      const validated = await this.authorizeFlow.validateRequest(
        loaded.transaction.request,
      );
      if (validated.kind === 'redirect') {
        return this.sendAuthorizationRedirect(response, validated.redirectUrl);
      }
      const currentSession = await this.sso.accountId(request);
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
        await this.setSessionCookie(response, account);
        const authorizeResult = await this.authorizeFlow.authorizeWithAccount(
          validated,
          account.id,
          account.credentialVersion ?? 0,
        );
        return this.sendAuthorizationRedirect(
          response,
          authorizeResult.redirectUrl,
        );
      } catch (error) {
        if (error instanceof UnauthorizedException) {
          this.setHostedPageSecurityHeaders(
            response,
            validated.request.redirectUri,
          );
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
        account.credentialVersion ?? 0,
      );
      return this.sendAuthorizationRedirect(
        response,
        authorizeResult.redirectUrl,
      );
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        const currentAccount = transaction.sessionAccountId
          ? await this.accounts.findById(transaction.sessionAccountId)
          : undefined;
        this.setHostedPageSecurityHeaders(
          response,
          validated.request.redirectUri,
        );
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

  private sendAuthorizationRedirect(response: Response, redirectUrl: string) {
    const protocol = new URL(redirectUrl).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      return response.redirect(redirectUrl);
    }
    // End form navigation before a callback redirects to another service origin.
    this.setHostedPageSecurityHeaders(response, redirectUrl);
    return response
      .status(200)
      .type('html')
      .send(this.authorizeFlow.renderAuthorizationRedirectPage(redirectUrl));
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
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.sso.clear(request, response);
    return { ok: true };
  }

  @Get('logout')
  async logoutPage(
    @Query('return_to') returnTo: string | undefined,
    @Res() response: Response,
    @Req() request: Request,
  ) {
    await this.sso.clear(request, response);
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
    await this.setSessionCookie(response, account);
    return {
      account: this.accounts.safeAccount(account),
    };
  }

  private async setSessionCookie(response: Response, account: AccountEntity) {
    await this.sso.create(account, response);
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

  private setHostedPageSecurityHeaders(
    response: Response,
    redirectUri: string,
  ) {
    response.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        this.authorizeFlow.hostedPageContentSecurityPolicy(redirectUri),
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
