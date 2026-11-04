import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { AuthorizeFlowService } from '../oidc/authorize-flow.service';
import { HostedLoginTransactionService } from '../oidc/hosted-login-transaction.service';
import {
  SocialCompleteDto,
  SocialEmailStartDto,
  SocialEmailVerifyDto,
  SocialStartDto,
} from './social-login.dto';
import {
  SocialBrowserContext,
  SocialCallbackResult,
  SocialLoginService,
} from './social-login.service';
import { renderSocialErrorPage, renderSocialSignupPage } from './social-pages';
import { SocialProvidersService } from './social-providers.service';

@Controller()
export class SocialLoginController {
  constructor(
    private readonly social: SocialLoginService,
    private readonly providers: SocialProvidersService,
    private readonly hosted: HostedLoginTransactionService,
    private readonly authorizeFlow: AuthorizeFlowService,
    private readonly config: AppConfigService,
  ) {}

  @Get('api/social/providers')
  providersList() {
    return { items: this.providers.list() };
  }

  @Post('oauth/login/social/:provider')
  async start(
    @Param('provider') provider: string,
    @Body() body: SocialStartDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    try {
      const nonce = this.signedCookie(
        request,
        this.hosted.cookieName(body.login_transaction),
      );
      const result = await this.social.start(
        provider,
        body.login_transaction,
        nonce,
        this.sessionAccountId(request),
      );
      response.clearCookie(this.hosted.cookieName(body.login_transaction), {
        httpOnly: true,
        secure: this.config.nodeEnv === 'production',
        sameSite: 'strict',
        path: '/oauth/login',
      });
      response.cookie(this.social.cookieName(result.state), result.binding, {
        httpOnly: true,
        secure: this.config.nodeEnv === 'production',
        sameSite: 'lax',
        signed: true,
        path: '/oauth/social',
        maxAge: 20 * 60 * 1000,
      });
      return this.navigate(response, result.authorizationUrl);
    } catch (error) {
      return this.failure(response, error);
    }
  }

  @Get('oauth/social/:provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query('state') state: string,
    @Query('code') code: string | undefined,
    @Query('error') error: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    try {
      if (
        (code !== undefined && typeof code !== 'string') ||
        (error !== undefined && typeof error !== 'string')
      ) {
        throw new BadRequestException('Invalid social callback');
      }
      const result = await this.social.callback(
        provider,
        state,
        this.context(state, request),
        code,
        error,
      );
      if (result.kind === 'signup') {
        this.pageHeaders(response);
        return response.redirect(
          `/oauth/social/signup?transaction=${encodeURIComponent(state)}`,
        );
      }
      return await this.finish(result, state, response);
    } catch (failure) {
      return this.failure(response, failure);
    }
  }

  @Get('oauth/social/signup')
  async signup(
    @Query('transaction') state: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    try {
      const page = await this.social.signupPage(
        state,
        this.context(state, request),
      );
      this.pageHeaders(response);
      return response.type('html').send(renderSocialSignupPage(page));
    } catch (error) {
      return this.failure(response, error);
    }
  }

  @Get('oauth/social/signup.js')
  signupScript(@Res() response: Response) {
    response.set({
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    return response
      .type('text/javascript')
      .send(
        readFileSync(
          join(__dirname, '..', '..', 'public', 'social-signup.js'),
          'utf8',
        ),
      );
  }

  @Get('oauth/social/assets/:asset')
  asset(@Param('asset') asset: string, @Res() response: Response) {
    const names: Record<string, string> = {
      'google.png': 'social-google.png',
      'kakao.svg': 'social-kakao.svg',
      'naver.png': 'social-naver.png',
    };
    const filename = Object.prototype.hasOwnProperty.call(names, asset)
      ? names[asset]
      : undefined;
    if (!filename) throw new BadRequestException('Unknown social asset');
    response.set({
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=86400',
    });
    return response.sendFile(join(__dirname, '..', '..', 'public', filename));
  }

  @Post('oauth/social/email/start')
  @HttpCode(200)
  sendEmail(@Body() body: SocialEmailStartDto, @Req() request: Request) {
    return this.social.sendEmailCode(
      body.transaction,
      this.context(body.transaction, request),
      body.email,
      request.ip ?? null,
    );
  }

  @Post('oauth/social/email/verify')
  @HttpCode(200)
  verifyEmail(@Body() body: SocialEmailVerifyDto, @Req() request: Request) {
    return this.social.verifyEmailCode(
      body.transaction,
      this.context(body.transaction, request),
      body.code,
    );
  }

  @Post('oauth/social/complete')
  async complete(
    @Body() body: SocialCompleteDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    try {
      const result = await this.social.complete(
        body.transaction,
        this.context(body.transaction, request),
        body,
      );
      return await this.finish(result, body.transaction, response);
    } catch (error) {
      try {
        const page = await this.social.signupPage(
          body.transaction,
          this.context(body.transaction, request),
        );
        this.pageHeaders(response);
        return response
          .status(error instanceof HttpException ? error.getStatus() : 400)
          .type('html')
          .send(
            renderSocialSignupPage({ ...page, error: this.message(error) }),
          );
      } catch {
        return this.failure(response, error);
      }
    }
  }

  private async finish(
    result: Extract<SocialCallbackResult, { kind: 'authenticated' }>,
    state: string,
    response: Response,
  ) {
    const validated = await this.authorizeFlow.validateRequest(result.request);
    if (validated.kind === 'redirect')
      return this.navigate(response, validated.redirectUrl);
    const authorized = await this.authorizeFlow.authorizeWithAccount(
      validated,
      result.account.id,
    );
    if (!result.request.prompt) {
      response.cookie('tas_session', result.account.id, {
        httpOnly: true,
        secure: this.config.nodeEnv === 'production',
        sameSite: 'lax',
        signed: true,
        maxAge: 12 * 60 * 60 * 1000,
      });
    }
    response.clearCookie(this.social.cookieName(state), {
      path: '/oauth/social',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.nodeEnv === 'production',
    });
    return this.navigate(response, authorized.redirectUrl);
  }

  private navigate(response: Response, url: string) {
    this.pageHeaders(response);
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:')
      return response.redirect(url);
    return response
      .status(200)
      .type('html')
      .send(this.authorizeFlow.renderAuthorizationRedirectPage(url));
  }

  private pageHeaders(response: Response) {
    response.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
  }

  private context(state: string, request: Request): SocialBrowserContext {
    if (typeof state !== 'string' || !state || state.length > 128)
      throw new BadRequestException('Invalid social login');
    return {
      binding: this.signedCookie(request, this.social.cookieName(state)),
      sessionAccountId: this.sessionAccountId(request),
    };
  }

  private signedCookie(request: Request, name: string): string {
    const cookies = request.signedCookies as
      | Record<string, unknown>
      | undefined;
    const value = cookies?.[name];
    if (typeof value !== 'string' || !value || value.length > 128)
      throw new BadRequestException('Invalid or expired login transaction');
    return value;
  }

  private sessionAccountId(request: Request): string | null {
    const cookies = request.signedCookies as
      | Record<string, unknown>
      | undefined;
    return typeof cookies?.tas_session === 'string'
      ? cookies.tas_session
      : null;
  }

  private message(error: unknown): string {
    return error instanceof HttpException
      ? error.message
      : 'Social login failed';
  }

  private failure(response: Response, error: unknown) {
    this.pageHeaders(response);
    return response
      .status(error instanceof HttpException ? error.getStatus() : 400)
      .type('html')
      .send(renderSocialErrorPage(this.message(error)));
  }
}
