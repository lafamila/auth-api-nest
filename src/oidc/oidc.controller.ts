import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AccountPermissionsService } from '../domain/account-permissions/account-permissions.service';
import { AccountsService } from '../domain/accounts/accounts.service';
import { OidcClientsService } from '../domain/oidc-clients/oidc-clients.service';
import { AppConfigService } from '../config/app-config.service';
import { AuthorizationCodeService } from './authorization-code.service';
import { AuthorizeFlowService } from './authorize-flow.service';
import { TokenRequestDto } from './dto/token.dto';
import { OAuthError } from './oauth-error';
import { verifyPkceS256 } from './pkce';
import { SigningKeyService } from './signing-key.service';
import { TokenService } from './token.service';

type SignedCookieRequest = Request & {
  signedCookies?: Record<string, string | undefined>;
};

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
      prompt_values_supported: ['login'],
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
        codeChallenge,
        codeChallengeMethod,
        prompt,
      });
      if (validated.kind === 'redirect') {
        return response.redirect(validated.redirectUrl);
      }
      const accountId = request.signedCookies?.tas_session;
      if (!accountId || prompt?.split(/\s+/).includes('login')) {
        return response
          .status(200)
          .type('html')
          .send(this.authorizeFlow.renderHostedLoginPage(validated.request));
      }
      const authorizeResult = await this.authorizeFlow.authorizeWithAccount(
        validated,
        accountId,
      );
      return response.redirect(authorizeResult.redirectUrl);
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
      const code = this.codes.consume(body.code);
      if (!code || code.clientId !== client.clientId) {
        throw new OAuthError('invalid_grant', 'Invalid authorization code');
      }
      if (code.redirectUri !== body.redirect_uri) {
        throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
      }
      if (!verifyPkceS256(body.code_verifier, code.codeChallenge)) {
        throw new OAuthError('invalid_grant', 'PKCE verification failed');
      }
      const account = await this.accounts.findById(code.accountId);
      if (account.passwordResetRequired) {
        throw new OAuthError(
          'access_denied',
          'Password reset is required',
          403,
        );
      }
      const permission = await this.requirePermission(
        account.id,
        client.serviceId,
      );
      return this.tokens.issueTokens(account, client, permission);
    }

    if (!body.refresh_token) {
      throw new OAuthError('invalid_request', 'refresh_token is required');
    }
    const refresh = await this.tokens.consumeRefreshToken(body.refresh_token);
    if (refresh.clientId !== client.clientId) {
      throw new UnauthorizedException('Refresh token client mismatch');
    }
    const account = await this.accounts.findById(refresh.accountId);
    if (account.passwordResetRequired) {
      throw new OAuthError('access_denied', 'Password reset is required', 403);
    }
    const permission = await this.requirePermission(
      account.id,
      client.serviceId,
    );
    return this.tokens.issueTokens(
      account,
      client,
      permission,
      refresh.familyId,
    );
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
  userinfo(@Headers('authorization') authorization?: string) {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    if (!token) {
      throw new UnauthorizedException('Bearer token is required');
    }
    const payload = this.tokens.verifyAccessToken(token);
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      preferred_username: payload.preferred_username,
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

  private async requirePermission(accountId: string, serviceId: string) {
    const permission =
      await this.accountPermissions.findActiveOrCreateVisitorForFirstLogin(
        accountId,
        serviceId,
      );
    if (!permission) {
      throw new OAuthError(
        'access_denied',
        'No active service permission',
        403,
      );
    }
    return permission;
  }
}
