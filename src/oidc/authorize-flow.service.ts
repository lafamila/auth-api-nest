import { Injectable } from '@nestjs/common';
import { AccountPermissionsService } from '../domain/account-permissions/account-permissions.service';
import { AccountsService } from '../domain/accounts/accounts.service';
import { OidcClientsService } from '../domain/oidc-clients/oidc-clients.service';
import { AuthorizationCodeService } from './authorization-code.service';
import { OAuthError } from './oauth-error';

export interface AuthorizeRequestInput {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  prompt?: string;
}

export interface AuthorizeRedirectResult {
  kind: 'redirect';
  redirectUrl: string;
}

export interface ValidatedAuthorizeRequest {
  kind: 'validated';
  client: Awaited<ReturnType<OidcClientsService['findByClientId']>>;
  request: AuthorizeRequestInput;
}

@Injectable()
export class AuthorizeFlowService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly clients: OidcClientsService,
    private readonly accountPermissions: AccountPermissionsService,
    private readonly codes: AuthorizationCodeService,
  ) {}

  async validateRequest(
    request: AuthorizeRequestInput,
  ): Promise<ValidatedAuthorizeRequest | AuthorizeRedirectResult> {
    if (request.responseType !== 'code') {
      throw new OAuthError('unsupported_response_type', 'Only code is supported');
    }
    if (!request.clientId || !request.redirectUri || !request.scope?.includes('openid')) {
      throw new OAuthError('invalid_request', 'Missing required authorize parameters');
    }
    const client = await this.clients.findByClientId(request.clientId);
    if (client.status !== 'active' || client.service.status !== 'active') {
      throw new OAuthError('unauthorized_client', 'Client is disabled');
    }
    if (!client.redirectUris.includes(request.redirectUri)) {
      throw new OAuthError('invalid_request', 'redirect_uri must exactly match');
    }
    if (client.requirePkce && request.codeChallengeMethod !== 'S256') {
      return {
        kind: 'redirect',
        redirectUrl: this.buildErrorRedirectUrl(
          request.redirectUri,
          request.state,
          'invalid_request',
          'S256 PKCE is required',
        ),
      };
    }
    return {
      kind: 'validated',
      client,
      request,
    };
  }

  async authorizeWithAccount(
    validated: ValidatedAuthorizeRequest,
    accountId: string,
  ): Promise<AuthorizeRedirectResult> {
    const account = await this.accounts.findById(accountId);
    if (account.status !== 'active') {
      return {
        kind: 'redirect',
        redirectUrl: this.buildErrorRedirectUrl(
          validated.request.redirectUri,
          validated.request.state,
          'access_denied',
          'Account is not active',
        ),
      };
    }
    if (account.passwordResetRequired) {
      return {
        kind: 'redirect',
        redirectUrl: this.buildErrorRedirectUrl(
          validated.request.redirectUri,
          validated.request.state,
          'access_denied',
          'Password reset is required',
        ),
      };
    }
    const permission = await this.accountPermissions.findActiveOrCreateVisitorForFirstLogin(
      account.id,
      validated.client.serviceId,
    );
    if (!permission) {
      return {
        kind: 'redirect',
        redirectUrl: this.buildErrorRedirectUrl(
          validated.request.redirectUri,
          validated.request.state,
          'access_denied',
          'No service permission',
        ),
      };
    }
    const code = this.codes.create({
      accountId: account.id,
      clientId: validated.client.clientId,
      redirectUri: validated.request.redirectUri,
      codeChallenge: validated.request.codeChallenge,
      codeChallengeMethod: 'S256',
      scope: validated.request.scope,
    });
    return {
      kind: 'redirect',
      redirectUrl: this.buildSuccessRedirectUrl(
        validated.request.redirectUri,
        validated.request.state,
        code,
      ),
    };
  }

  renderHostedLoginPage(request: AuthorizeRequestInput, failureMessage = '') {
    const hiddenFields = [
      this.hiddenInput('client_id', request.clientId),
      this.hiddenInput('redirect_uri', request.redirectUri),
      this.hiddenInput('response_type', request.responseType),
      this.hiddenInput('scope', request.scope),
      this.hiddenInput('state', request.state),
      this.hiddenInput('code_challenge', request.codeChallenge),
      this.hiddenInput('code_challenge_method', request.codeChallengeMethod),
      this.hiddenInput('prompt', request.prompt),
    ].join('');
    const failureText = this.escapeHtml(failureMessage);
    const failureVisibility = failureText ? 'visible' : 'hidden';
    return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>로그인</title>
    <style>
      :root {
        color-scheme: light;
        font-family: system-ui, sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f4f4f4;
      }
      form {
        width: min(320px, calc(100vw - 32px));
        display: grid;
        gap: 12px;
      }
      input,
      button,
      a,
      p {
        box-sizing: border-box;
        font: inherit;
      }
      input,
      button {
        width: 100%;
        padding: 12px;
      }
      a {
        color: inherit;
        text-decoration: none;
      }
      #failure-message {
        min-height: 1.25rem;
        margin: 0;
        color: #b42318;
        visibility: ${failureVisibility};
      }
    </style>
  </head>
  <body>
    <form method="post" action="/oauth/login">
      ${hiddenFields}
      <input
        name="loginId"
        type="text"
        placeholder="ID"
        aria-label="ID"
        autocomplete="username"
        required
      />
      <input
        name="password"
        type="password"
        placeholder="PW"
        aria-label="PW"
        autocomplete="current-password"
        required
      />
      <button type="submit">로그인</button>
      <a href="/signup">signup</a>
      <p id="failure-message" role="alert">${failureText}</p>
    </form>
  </body>
</html>`;
  }

  buildErrorRedirectUrl(
    redirectUri: string,
    state: string | undefined,
    error: string,
    errorDescription: string,
  ) {
    const redirect = new URL(redirectUri);
    redirect.searchParams.set('error', error);
    redirect.searchParams.set('error_description', errorDescription);
    if (state) {
      redirect.searchParams.set('state', state);
    }
    return redirect.toString();
  }

  private buildSuccessRedirectUrl(
    redirectUri: string,
    state: string | undefined,
    code: string,
  ) {
    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    if (state) {
      redirect.searchParams.set('state', state);
    }
    return redirect.toString();
  }

  private hiddenInput(name: string, value?: string) {
    if (value === undefined) {
      return '';
    }
    return `<input type="hidden" name="${this.escapeHtml(name)}" value="${this.escapeHtml(value)}" />`;
  }

  private escapeHtml(value: string) {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
}
