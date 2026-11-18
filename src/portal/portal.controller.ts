import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';
import { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdminAuthService } from '../admin/admin-auth.service';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { AdminSessionEntity } from '../database/entities/admin-session.entity';
import { AuthorizeFlowService } from '../oidc/authorize-flow.service';
import { HostedLoginTransactionService } from '../oidc/hosted-login-transaction.service';
import { SsoSessionService } from '../oidc/sso-session.service';
import { SocialLoginService } from '../social/social-login.service';
import { PortalAuthService } from './portal-auth.service';
import {
  PortalEmailCompleteDto,
  PortalEmailStartDto,
  PortalPasswordDto,
} from './portal-profile.dto';
import { PortalProfileService } from './portal-profile.service';
import { privatePageHeaders, renderOtpPage } from './portal-pages';
import { PortalSessionService } from './portal-session.service';
import { PublicSiteService } from '../public-site/public-site.service';
import { AccountPoliciesService } from '../policies/account-policies.service';
import { PolicyAcceptanceDto } from '../policies/policy-acceptance.dto';
import { AccountLifecycleService } from './account-lifecycle.service';
import { UnlinkProviderDto, WithdrawAccountDto } from './account-lifecycle.dto';

class OtpDto {
  @IsString() @Length(1, 128) transaction!: string;
  @IsString() @Matches(/^\d{6}$/) code!: string;
}
class LinkDto {}

@Controller()
export class PortalController {
  constructor(
    private readonly sessions: PortalSessionService,
    private readonly auth: PortalAuthService,
    private readonly profile: PortalProfileService,
    private readonly admin: AdminAuthService,
    private readonly hosted: HostedLoginTransactionService,
    private readonly flow: AuthorizeFlowService,
    private readonly social: SocialLoginService,
    private readonly sso: SsoSessionService,
    private readonly config: AppConfigService,
    private readonly publicSite: PublicSiteService,
    private readonly policies: AccountPoliciesService,
    private readonly lifecycle: AccountLifecycleService,
  ) {}

  @Get('/')
  async root(@Req() request: Request, @Res() response: Response) {
    const account = await this.signedInAccount(request, response);
    if (!account) return response.redirect('/login');
    return this.file(
      response,
      account.isSuperAdmin ? 'index.html' : 'portal.html',
    );
  }

  @Get('profile')
  async profilePage(@Req() request: Request, @Res() response: Response) {
    if (!(await this.signedInAccount(request, response)))
      return response.redirect('/login');
    return this.file(response, 'portal.html');
  }

  @Get('login')
  async login(
    @Query('reauth') reauth: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const actor = await this.sessions.read(request);
    let expected = actor?.account.id;
    if (!actor) {
      try {
        expected = (await this.admin.validateRequest(request)).id;
      } catch (error) {
        if (
          !(
            error instanceof UnauthorizedException ||
            error instanceof ForbiddenException
          )
        )
          throw error;
      }
    }
    if (expected && reauth !== '1') return response.redirect('/');
    const transaction = await this.hosted.createPortal(
      await this.sso.accountId(request),
      reauth === '1' ? expected : undefined,
    );
    response.cookie(
      this.hosted.cookieName(transaction.id),
      transaction.browserNonce,
      {
        httpOnly: true,
        signed: true,
        sameSite: 'strict',
        secure: this.config.nodeEnv === 'production',
        path: '/oauth/login',
        maxAge: 5 * 60 * 1000,
      },
    );
    let html = this.flow.renderHostedLoginPage(null, transaction.id);
    if ((await this.admin.bootstrapStatus()).requiresBootstrap)
      html = html.replace(
        '</form>',
        '<a href="/bootstrap">초기 관리자 설정</a></form>',
      );
    response.set(privatePageHeaders(html));
    return response.type('html').send(html);
  }

  @Get('login/otp')
  async otp(
    @Query('transaction') transaction: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const page = await this.auth.mfaPage(transaction, request);
    const html = this.publicSite.decorate(
      renderOtpPage(page.transaction, page.name),
      'form',
    );
    response.set(privatePageHeaders(html));
    return response.type('html').send(html);
  }

  @Post('login/otp')
  async verifyOtp(
    @Body() body: OtpDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    try {
      return this.navigate(
        response,
        await this.auth.verifyOtp(
          body.transaction,
          body.code,
          request,
          response,
        ),
      );
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
      const page = await this.auth.mfaPage(body.transaction, request);
      const html = this.publicSite.decorate(
        renderOtpPage(body.transaction, page.name, error.message),
        'form',
      );
      response.set(privatePageHeaders(html));
      return response.status(401).type('html').send(html);
    }
  }

  @Get('bootstrap')
  async bootstrap(@Res() response: Response) {
    if (!(await this.admin.bootstrapStatus()).requiresBootstrap)
      throw new NotFoundException();
    return this.file(response, 'bootstrap.html');
  }

  @Get('portal/assets/:asset')
  asset(@Param('asset') asset: string, @Res() response: Response) {
    if (!['portal.css', 'portal.js'].includes(asset))
      throw new NotFoundException();
    response.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    return response.sendFile(join(__dirname, '..', '..', 'public', asset));
  }

  @Get('portal/assets/icons/:asset')
  icon(@Param('asset') asset: string, @Res() response: Response) {
    if (
      ![
        'check.svg',
        'key-round.svg',
        'layout-grid.svg',
        'link.svg',
        'log-out.svg',
        'shield-check.svg',
        'user-round.svg',
        'x.svg',
      ].includes(asset)
    )
      throw new NotFoundException();
    response.set({
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    return response.sendFile(
      join(__dirname, '..', '..', 'public', 'portal-icons', asset),
    );
  }

  @Get('api/portal/me')
  async me(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.set('Cache-Control', 'no-store');
    return this.profile.overview(await this.sessions.require(request));
  }

  @Post('api/portal/email/start')
  @HttpCode(200)
  async startEmail(@Body() body: PortalEmailStartDto, @Req() request: Request) {
    return this.profile.startEmailChange(
      await this.sessions.require(request, true),
      body,
      request.ip ?? null,
    );
  }

  @Post('api/portal/email/complete')
  @HttpCode(200)
  async completeEmail(
    @Body() body: PortalEmailCompleteDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.profile.completeEmailChange(
      await this.sessions.require(request, true),
      body,
    );
    await this.logoutCookies(request, response);
    return result;
  }

  @Post('api/portal/password')
  @HttpCode(200)
  async password(
    @Body() body: PortalPasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.profile.changePassword(
      await this.sessions.require(request, true),
      body,
    );
    await this.logoutCookies(request, response);
    return result;
  }

  @Post('api/portal/social/:provider/link')
  @HttpCode(200)
  async link(
    @Param('provider') provider: string,
    @Body() body: LinkDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (Object.keys(body ?? {}).length)
      throw new BadRequestException('Unexpected social link fields');
    const actor = await this.sessions.require(request, true);
    this.sessions.requireRecent(actor);
    const result = await this.social.startLink(provider, actor, {
      binding: '',
      sessionAccountId: await this.sso.accountId(request),
    });
    response.cookie(this.social.cookieName(result.state), result.binding, {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: this.config.nodeEnv === 'production',
      path: '/oauth/social',
      maxAge: 20 * 60 * 1000,
    });
    return {
      redirectUrl: `/oauth/social/continue?transaction=${encodeURIComponent(result.state)}`,
    };
  }

  @Get('api/portal/policies')
  async policyStatus(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.set('Cache-Control', 'no-store');
    return this.policies.status(await this.sessions.require(request));
  }

  @Post('api/portal/policies')
  @HttpCode(200)
  async acceptPolicies(
    @Body() input: PolicyAcceptanceDto,
    @Req() request: Request,
  ) {
    return this.policies.accept(
      await this.sessions.require(request, true),
      input,
    );
  }

  @Get('api/portal/lifecycle')
  async lifecycleStatus(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.set('Cache-Control', 'no-store');
    return this.lifecycle.overview(await this.sessions.require(request));
  }

  @Post('api/portal/social/:provider/unlink')
  @HttpCode(200)
  async unlinkProvider(
    @Param('provider') provider: string,
    @Body() input: UnlinkProviderDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.sessions.require(request, true);
    this.sessions.requireRecent(actor);
    const result = await this.lifecycle.unlink(actor, provider, input);
    await this.logoutCookies(request, response);
    return result;
  }

  @Post('api/portal/withdraw')
  @HttpCode(200)
  async withdrawAccount(
    @Body() input: WithdrawAccountDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.sessions.require(request, true);
    this.sessions.requireRecent(actor);
    const result = await this.lifecycle.withdraw(actor, input);
    await this.logoutCookies(request, response);
    return result;
  }

  @Post('api/portal/social/:provider/reconnect')
  @HttpCode(200)
  async reconnect(
    @Param('provider') provider: string,
    @Body() body: LinkDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (Object.keys(body ?? {}).length)
      throw new BadRequestException('Unexpected social reconnect fields');
    const actor = await this.sessions.require(request, true);
    this.sessions.requireRecent(actor);
    const result = await this.social.startReconnect(provider, actor, {
      binding: '',
      sessionAccountId: await this.sso.accountId(request),
    });
    response.cookie(this.social.cookieName(result.state), result.binding, {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: this.config.nodeEnv === 'production',
      path: '/oauth/social',
      maxAge: 20 * 60 * 1000,
    });
    return {
      redirectUrl: `/oauth/social/continue?transaction=${encodeURIComponent(result.state)}`,
    };
  }

  @Post('api/portal/logout')
  @HttpCode(200)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.sessions.require(request, true);
    await this.logoutCookies(request, response);
    return { ok: true };
  }

  private async logoutCookies(request: Request, response: Response) {
    await this.sessions.clear(request, response);
    await this.admin.logout(request, response);
    await this.sso.clear(request, response);
  }

  private async signedInAccount(
    request: Request,
    response: Response,
  ): Promise<AccountEntity | null> {
    const actor = await this.sessions.read(request);
    if (actor?.account.isSuperAdmin) return actor.account;
    try {
      const account = await this.admin.validateRequest(request);
      const session = (
        request as Request & { adminSession?: AdminSessionEntity }
      ).adminSession;
      if (!session) return null;
      if (actor) await this.sessions.clear(request, response);
      await this.sessions.create(account, response, {
        method: 'legacy-admin',
        authenticatedAt: session.createdAt,
        adminSessionId: session.id,
      });
      return account;
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      )
        return actor?.account ?? null;
      throw error;
    }
  }

  private file(response: Response, filename: string) {
    const html = this.publicSite.decorate(
      readFileSync(join(__dirname, '..', '..', 'public', filename), 'utf8'),
      filename === 'bootstrap.html' ? 'form' : 'application',
    );
    response.set(privatePageHeaders(html));
    return response.type('html').send(html);
  }

  private navigate(response: Response, path: string) {
    if (!['/', '/profile'].includes(path))
      throw new BadRequestException('Invalid portal destination');
    const html = this.flow.renderAuthorizationRedirectPage(
      new URL(path, this.config.issuerUrl).toString(),
    );
    response.set(privatePageHeaders(html));
    return response.status(200).type('html').send(html);
  }
}
