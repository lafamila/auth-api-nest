import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { DataSource, EntityManager } from 'typeorm';
import { AccountEntity } from '../database/entities/account.entity';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { AccountPermissionsService } from '../domain/account-permissions/account-permissions.service';
import { AccountsService } from '../domain/accounts/accounts.service';
import { OidcClientsService } from '../domain/oidc-clients/oidc-clients.service';
import { AppConfigService } from '../config/app-config.service';
import {
  AuthorizationCodeRecord,
  AuthorizationCodeService,
} from './authorization-code.service';
import {
  AuthorizeFlowService,
  SELECT_ACCOUNT_PROMPT,
} from './authorize-flow.service';
import { TokenRequestDto } from './dto/token.dto';
import { OAuthError } from './oauth-error';
import { verifyPkceS256 } from './pkce';
import { SigningKeyService } from './signing-key.service';
import { RefreshTokenReuseError, TokenService } from './token.service';
import { HostedLoginTransactionService } from './hosted-login-transaction.service';
import { SsoSessionService } from './sso-session.service';
import {
  authenticationMethod,
  AUTHENTICATION_METHOD_CLAIM,
  gameLoginDenial,
  gameLoginPolicyCode,
  SERVICE_CATEGORY_CLAIM,
} from './authentication-method';
import { PortalAuthService } from '../portal/portal-auth.service';
import { ServiceEntity } from '../database/entities/service.entity';

type SignedCookieRequest = Request & {
  signedCookies?: Record<string, string | undefined>;
};

type TokenTransactionResult =
  | {
      kind: 'success';
      response: Awaited<ReturnType<TokenService['issueTokens']>>;
    }
  | { kind: 'error'; error: Error };

@Controller()
export class OidcController {
  constructor(
    private readonly config: AppConfigService,
    private readonly accountPermissions: AccountPermissionsService,
    private readonly accounts: AccountsService,
    private readonly clients: OidcClientsService,
    private readonly codes: AuthorizationCodeService,
    private readonly authorizeFlow: AuthorizeFlowService,
    private readonly signingKeys: SigningKeyService,
    private readonly tokens: TokenService,
    private readonly hostedLoginTransactions: HostedLoginTransactionService,
    private readonly sso: SsoSessionService,
    private readonly dataSource: DataSource,
    private readonly portal?: PortalAuthService,
  ) {}

  @Get('.well-known/openid-configuration')
  discovery() {
    const issuer = this.config.issuerUrl;
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      jwks_uri: `${issuer}/oauth/jwks`,
      userinfo_endpoint: `${issuer}/oidc/userinfo`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: [
        'client_secret_post',
        'client_secret_basic',
        'none',
      ],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'profile', 'email', 'service.permission'],
      prompt_values_supported: [SELECT_ACCOUNT_PROMPT],
    };
  }

  @Get('oauth/jwks')
  jwks() {
    return this.signingKeys.jwks();
  }

  @Get('oauth/authorize')
  async authorize(
    @Query('client_id') clientId: string,
    @Query('redirect_uri') redirectUri: string,
    @Query('response_type') responseType: string,
    @Query('scope') scope: string,
    @Query('state') state: string | undefined,
    @Query('nonce') nonce: string | undefined,
    @Query('code_challenge') codeChallenge: string,
    @Query('code_challenge_method') codeChallengeMethod: string,
    @Query('prompt') prompt: string | undefined,
    @Req() request: SignedCookieRequest,
    @Res() response: Response,
  ) {
    try {
      const validated = await this.authorizeFlow.validateRequest({
        clientId,
        redirectUri,
        responseType,
        scope,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod,
        prompt,
      });
      if (validated.kind === 'redirect') {
        return response.redirect(validated.redirectUrl);
      }
      const context = await this.sso.context(request);
      const accountId = context?.accountId ?? null;
      const method = context?.authenticationMethod ?? 'legacy';
      if (
        accountId &&
        gameLoginDenial(validated.client.service.category, method) &&
        method === 'kakao'
      ) {
        const denied = await this.authorizeFlow.authorizeWithAccount(
          validated,
          accountId,
          context?.credentialVersion,
          method,
        );
        await this.portal!.signOutKakao(accountId, request, response);
        const html = this.authorizeFlow.renderAuthorizationRedirectPage(
          denied.redirectUrl,
          denied.policyDenied,
        );
        this.setHostedPageSecurityHeaders(
          response,
          validated.request.redirectUri,
        );
        return response.status(200).type('html').send(html);
      }
      const requiresFreshLogin = Boolean(
        gameLoginDenial(validated.client.service.category, method),
      );
      if (validated.request.prompt === SELECT_ACCOUNT_PROMPT) {
        const currentAccount =
          accountId && !requiresFreshLogin
            ? await this.accounts.findById(accountId)
            : undefined;
        const transaction = await this.hostedLoginTransactions.create({
          request: validated.request,
          sessionAccountId: accountId ?? null,
        });
        this.setHostedLoginTransactionCookie(
          response,
          transaction.id,
          transaction.browserNonce,
        );
        const html = this.authorizeFlow.renderAccountSelectionPage(
          validated.request,
          transaction.id,
          currentAccount,
        );
        this.setHostedPageSecurityHeaders(
          response,
          validated.request.redirectUri,
        );
        return response.status(200).type('html').send(html);
      }
      if (!accountId || requiresFreshLogin) {
        const transaction = await this.hostedLoginTransactions.create({
          request: validated.request,
          sessionAccountId: accountId,
        });
        this.setHostedLoginTransactionCookie(
          response,
          transaction.id,
          transaction.browserNonce,
        );
        const html = this.authorizeFlow.renderHostedLoginPage(
          validated.request,
          transaction.id,
        );
        this.setHostedPageSecurityHeaders(
          response,
          validated.request.redirectUri,
        );
        return response.status(200).type('html').send(html);
      }
      const authorizeResult = await this.authorizeFlow.authorizeWithAccount(
        validated,
        accountId,
        context?.credentialVersion,
        method,
      );
      return response.redirect(authorizeResult.redirectUrl);
    } catch (error) {
      if (error instanceof OAuthError) {
        return response.status(error.statusCode).json({
          error: error.error,
          error_description: error.errorDescription,
          ...(error.code ? { code: error.code } : {}),
        });
      }
      throw error;
    }
  }

  private setHostedLoginTransactionCookie(
    response: Response,
    transactionId: string,
    browserNonce: string,
  ) {
    response.cookie(
      this.hostedLoginTransactions.cookieName(transactionId),
      browserNonce,
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        signed: true,
        maxAge: 5 * 60 * 1000,
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

  @Post('oauth/token')
  @HttpCode(200)
  async token(
    @Body() body: TokenRequestDto,
    @Headers('authorization') auth?: string,
  ) {
    const clientCredentials = this.extractClientCredentials(body, auth);
    const client = await this.clients.findByClientId(
      clientCredentials.clientId,
    );
    if (client.status !== 'active' || client.service.status !== 'active') {
      throw new OAuthError('unauthorized_client', 'Client is disabled', 403);
    }
    await this.clients.validateClientSecret(
      client,
      clientCredentials.clientSecret,
    );

    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.redirect_uri || !body.code_verifier) {
        throw new OAuthError(
          'invalid_request',
          'Missing authorization_code fields',
        );
      }
      const candidate = await this.codes.findActive(body.code);
      const candidateError = this.authorizationCodeError(
        candidate,
        client.clientId,
        body.redirect_uri,
        body.code_verifier,
      );
      if (candidateError) {
        throw candidateError;
      }
      await this.requirePermission(candidate!.accountId, client.serviceId);

      const result = await this.dataSource.transaction<TokenTransactionResult>(
        async (manager) => {
          const account = await this.lockAccount(manager, candidate!.accountId);
          if (!account) {
            return {
              kind: 'error',
              error: new OAuthError(
                'invalid_grant',
                'Invalid authorization code',
              ),
            };
          }
          const code = await this.codes.consume(body.code!, manager);
          const codeError = this.authorizationCodeError(
            code,
            client.clientId,
            body.redirect_uri!,
            body.code_verifier!,
          );
          if (codeError) {
            return { kind: 'error', error: codeError };
          }
          if (!this.codes.isCurrentCredential(code!, account)) {
            return {
              kind: 'error',
              error: new OAuthError(
                'invalid_grant',
                'Authorization code credentials are stale',
              ),
            };
          }
          const accountError = this.accountTokenError(account);
          if (accountError) {
            return { kind: 'error', error: accountError };
          }
          const method = authenticationMethod(code!.authenticationMethod);
          const denial = gameLoginDenial(client.service.category, method);
          if (denial)
            return {
              kind: 'error',
              error: new OAuthError(
                'access_denied',
                denial,
                403,
                gameLoginPolicyCode(method),
              ),
            };
          const permission = await this.findCurrentPermission(
            manager,
            account.id,
            client.serviceId,
          );
          if (!permission) {
            return {
              kind: 'error',
              error: this.permissionDeniedError(),
            };
          }
          return {
            kind: 'success',
            response: await this.tokens.issueTokens(
              account,
              client,
              permission,
              undefined,
              code!.nonce,
              manager,
              method,
            ),
          };
        },
      );
      if (result.kind === 'error') {
        throw result.error;
      }
      return result.response;
    }

    if (!body.refresh_token) {
      throw new OAuthError('invalid_request', 'refresh_token is required');
    }
    // Deny disabled accounts before consuming the token so a lockout cannot be
    // laundered into a fresh access token, and so a still-valid token is not
    // burned by the attempt.
    const holder = await this.tokens.getRefreshTokenAccountId(
      body.refresh_token,
    );
    if (!holder) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (holder.clientId !== client.clientId) {
      throw new UnauthorizedException('Refresh token client mismatch');
    }
    let holderAccount: AccountEntity;
    try {
      holderAccount = await this.accounts.findById(holder.accountId);
    } catch (error) {
      if (error instanceof NotFoundException)
        throw new UnauthorizedException('Invalid refresh token');
      throw error;
    }
    if (holderAccount.status !== 'active') {
      throw new OAuthError('access_denied', 'Account is not active', 403);
    }
    await this.requirePermission(holder.accountId, client.serviceId);

    const result = await this.dataSource.transaction<TokenTransactionResult>(
      async (manager) => {
        const account = await this.lockAccount(manager, holder.accountId);
        if (!account || account.status !== 'active') {
          return {
            kind: 'error',
            error: new OAuthError(
              'access_denied',
              'Account is not active',
              403,
            ),
          };
        }
        const consumption = await this.tokens.consumeRefreshTokenForRotation(
          body.refresh_token!,
          manager,
        );
        if (consumption.kind === 'reuse') {
          return {
            kind: 'error',
            error: new RefreshTokenReuseError(),
          };
        }
        const refresh = consumption.refresh;
        if (
          refresh.clientId !== client.clientId ||
          refresh.accountId !== account.id
        ) {
          return {
            kind: 'error',
            error: new UnauthorizedException('Refresh token client mismatch'),
          };
        }
        if (!this.tokens.isCurrentCredential(refresh, account)) {
          await this.tokens.revokeFamily(refresh.familyId, manager);
          return {
            kind: 'error',
            error: new UnauthorizedException('Invalid refresh token'),
          };
        }
        const method = authenticationMethod(refresh.authenticationMethod);
        const denial = gameLoginDenial(client.service.category, method);
        if (denial) {
          await this.tokens.revokeFamily(refresh.familyId, manager);
          return {
            kind: 'error',
            error: new OAuthError(
              'access_denied',
              denial,
              403,
              gameLoginPolicyCode(method),
            ),
          };
        }
        const accountError = this.accountTokenError(account);
        if (accountError) {
          return { kind: 'error', error: accountError };
        }
        const permission = await this.findCurrentPermission(
          manager,
          account.id,
          client.serviceId,
        );
        if (!permission) {
          return {
            kind: 'error',
            error: this.permissionDeniedError(),
          };
        }
        return {
          kind: 'success',
          response: await this.tokens.issueTokens(
            account,
            client,
            permission,
            refresh.familyId,
            undefined,
            manager,
            method,
          ),
        };
      },
    );
    if (result.kind === 'error') {
      throw result.error;
    }
    return result.response;
  }

  @Post('oauth/revoke')
  @HttpCode(200)
  async revoke(@Body('token') token: string) {
    if (token) {
      await this.tokens.revokeRefreshToken(token);
    }
    return {};
  }

  @Post('oauth/introspect')
  @HttpCode(200)
  introspect(@Body('token') token: string) {
    try {
      const payload = this.tokens.verifyAccessToken(token);
      return { active: true, ...payload };
    } catch {
      return { active: false };
    }
  }

  @Get('oidc/userinfo')
  async userinfo(@Headers('authorization') authorization?: string) {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    if (!token) {
      throw new UnauthorizedException('Bearer token is required');
    }
    const payload = this.tokens.verifyAccessToken(token);
    if (typeof payload.sub !== 'string')
      throw new UnauthorizedException('Invalid subject');
    let account: AccountEntity;
    try {
      account = await this.accounts.findById(payload.sub);
    } catch (error) {
      if (error instanceof NotFoundException)
        throw new UnauthorizedException('Account is unavailable');
      throw error;
    }
    if (this.accountTokenError(account))
      throw new UnauthorizedException('Account is unavailable');
    const claim = payload['https://lafamila.xyz/claims/service'];
    if (
      !claim ||
      typeof claim !== 'object' ||
      !('key' in claim) ||
      typeof claim.key !== 'string' ||
      payload.aud !== `service:${claim.key}`
    )
      throw new UnauthorizedException('Invalid access token audience');
    const service = await this.dataSource
      .getRepository(ServiceEntity)
      .findOneBy({ serviceKey: claim.key, status: 'active' });
    if (!service) throw new UnauthorizedException('Service is unavailable');
    const method = authenticationMethod(payload[AUTHENTICATION_METHOD_CLAIM]);
    const denial = gameLoginDenial(service.category, method);
    if (denial)
      throw new OAuthError(
        'access_denied',
        denial,
        403,
        gameLoginPolicyCode(method),
      );
    if (
      !(await this.findCurrentPermission(
        this.dataSource.manager,
        account.id,
        service.id,
      ))
    )
      throw this.permissionDeniedError();
    return {
      sub: account.id,
      email: account.email,
      name: account.name,
      preferred_username: account.loginId ?? account.email,
      'https://lafamila.xyz/claims/local_login_id': account.loginId,
      [AUTHENTICATION_METHOD_CLAIM]: method,
      [SERVICE_CATEGORY_CLAIM]: service.category ?? 'other',
    };
  }

  private extractClientCredentials(body: TokenRequestDto, auth?: string) {
    if (auth?.startsWith('Basic ')) {
      const decoded = Buffer.from(
        auth.slice('Basic '.length),
        'base64',
      ).toString('utf8');
      const [clientId, clientSecret] = decoded.split(':');
      return { clientId, clientSecret };
    }
    if (!body.client_id) {
      throw new UnauthorizedException('client_id is required');
    }
    return {
      clientId: body.client_id,
      clientSecret: body.client_secret,
    };
  }

  private authorizationCodeError(
    code: AuthorizationCodeRecord | null,
    clientId: string,
    redirectUri: string,
    codeVerifier: string,
  ): OAuthError | null {
    if (!code || code.clientId !== clientId) {
      return new OAuthError('invalid_grant', 'Invalid authorization code');
    }
    if (code.redirectUri !== redirectUri) {
      return new OAuthError('invalid_grant', 'redirect_uri mismatch');
    }
    if (!verifyPkceS256(codeVerifier, code.codeChallenge)) {
      return new OAuthError('invalid_grant', 'PKCE verification failed');
    }
    return null;
  }

  private async lockAccount(
    manager: EntityManager,
    accountId: string,
  ): Promise<AccountEntity | null> {
    return manager.getRepository(AccountEntity).findOne({
      where: { id: accountId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  private accountTokenError(account: AccountEntity): OAuthError | null {
    if (account.status !== 'active') {
      return new OAuthError('access_denied', 'Account is not active', 403);
    }
    if (account.passwordResetRequired) {
      return new OAuthError('access_denied', 'Password reset is required', 403);
    }
    return null;
  }

  private findCurrentPermission(
    manager: EntityManager,
    accountId: string,
    serviceId: string,
  ): Promise<AccountServicePermissionEntity | null> {
    return manager.getRepository(AccountServicePermissionEntity).findOne({
      where: { accountId, serviceId, status: 'active' },
      relations: { permissionDefinition: true },
    });
  }

  private permissionDeniedError(): OAuthError {
    return new OAuthError('access_denied', 'No active service permission', 403);
  }

  private async requirePermission(accountId: string, serviceId: string) {
    const permission =
      await this.accountPermissions.findActiveOrCreateVisitorForFirstLogin(
        accountId,
        serviceId,
      );
    if (!permission) {
      throw this.permissionDeniedError();
    }
    return permission;
  }
}
