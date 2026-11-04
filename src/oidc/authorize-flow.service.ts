import { Injectable } from '@nestjs/common';
import { AccountPermissionsService } from '../domain/account-permissions/account-permissions.service';
import { AccountsService } from '../domain/accounts/accounts.service';
import { OidcClientsService } from '../domain/oidc-clients/oidc-clients.service';
import { AuthorizationCodeService } from './authorization-code.service';
import { OAuthError } from './oauth-error';
import { SocialProvidersService } from '../social/social-providers.service';

export const SELECT_ACCOUNT_PROMPT = 'select_account';

export interface AuthorizeRequestInput {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  state?: string;
  nonce?: string;
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
    private readonly socialProviders?: SocialProvidersService,
  ) {}

  async validateRequest(
    request: AuthorizeRequestInput,
  ): Promise<ValidatedAuthorizeRequest | AuthorizeRedirectResult> {
    if (request.responseType !== 'code') {
      throw new OAuthError(
        'unsupported_response_type',
        'Only code is supported',
      );
    }
    if (
      !request.clientId ||
      !request.redirectUri ||
      !request.scope?.split(/\s+/).includes('openid')
    ) {
      throw new OAuthError(
        'invalid_request',
        'Missing required authorize parameters',
      );
    }
    if (
      request.nonce !== undefined &&
      (request.nonce.length === 0 ||
        request.nonce.length > 255 ||
        // eslint-disable-next-line no-control-regex -- Intentionally reject C0 and DEL in OAuth nonce.
        /[\u0000-\u001f\u007f]/.test(request.nonce))
    ) {
      throw new OAuthError('invalid_request', 'Invalid nonce');
    }
    const client = await this.clients.findByClientId(request.clientId);
    if (client.status !== 'active' || client.service.status !== 'active') {
      throw new OAuthError('unauthorized_client', 'Client is disabled');
    }
    if (!client.redirectUris.includes(request.redirectUri)) {
      throw new OAuthError(
        'invalid_request',
        'redirect_uri must exactly match',
      );
    }
    if (
      request.prompt !== undefined &&
      request.prompt !== SELECT_ACCOUNT_PROMPT
    ) {
      return {
        kind: 'redirect',
        redirectUrl: this.buildErrorRedirectUrl(
          request.redirectUri,
          request.state,
          'invalid_request',
          'Unsupported prompt value or combination',
        ),
      };
    }
    const requiresPkce = client.clientType === 'public' || client.requirePkce;
    if (
      requiresPkce &&
      (!request.codeChallenge || request.codeChallengeMethod !== 'S256')
    ) {
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
    const permission =
      await this.accountPermissions.findActiveOrCreateVisitorForFirstLogin(
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
    const code = await this.codes.create({
      accountId: account.id,
      clientId: validated.client.clientId,
      redirectUri: validated.request.redirectUri,
      codeChallenge: validated.request.codeChallenge,
      codeChallengeMethod: 'S256',
      scope: validated.request.scope,
      nonce: validated.request.nonce,
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

  renderHostedLoginPage(
    request: AuthorizeRequestInput,
    loginTransaction: string,
    failureMessage = '',
  ) {
    const hiddenFields = this.hiddenInput(
      'login_transaction',
      loginTransaction,
    );
    const failureText = this.escapeHtml(failureMessage);
    const failureVisibility = failureText ? 'visible' : 'hidden';
    const signupHref = this.escapeHtml(this.buildSignupUrl(request));
    const social = this.renderSocialLogin(loginTransaction);
    return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>로그인</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #eef1f5;
        --panel: #ffffff;
        --line: #d9dee7;
        --text: #151b28;
        --muted: #687386;
        --accent: #1d4ed8;
        --accent-soft: #e9efff;
        --danger: #b42318;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: var(--bg);
        color: var(--text);
      }
      form {
        width: min(340px, calc(100vw - 32px));
        display: grid;
        gap: 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        box-shadow: 0 18px 50px rgb(25 33 48 / 10%);
        padding: 22px;
      }
      h1 {
        margin: 0 0 4px;
        font-size: 21px;
        line-height: 1.2;
      }
      .subtitle {
        margin: 0 0 10px;
        color: var(--muted);
        font-size: 13px;
      }
      input,
      button {
        width: 100%;
        border-radius: 6px;
        font: inherit;
        outline: none;
      }
      input {
        border: 1px solid var(--line);
        color: var(--text);
        font-size: 16px;
        padding: 10px;
      }
      input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-soft);
      }
      button {
        min-height: 40px;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        cursor: pointer;
        font-size: 14px;
        font-weight: 700;
        padding: 9px 12px;
      }
      button:disabled {
        cursor: wait;
        opacity: 0.72;
      }
      .social-logins { display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 12px; }
      .social-logins button { font-weight: 600; padding: 0; height: 48px; display: grid; place-items: center; overflow: hidden; }
      .social-logins img { height: 48px; width: auto; max-width: 100%; object-fit: contain; }
      .social-google img { height: 40px; clip-path: inset(2px); }
      .social-google { background: #fff; color: #202124; border-color: #dadce0; }
      .social-kakao { background: #fee500; color: #191919; border-color: #fee500; }
      .social-naver { background: #03a94d; color: #fff; border-color: #03a94d; }
      .social-provider-form { display: none; }
      a {
        display: block;
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--accent);
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        padding: 9px 12px;
        text-align: center;
        text-decoration: none;
      }
      a:hover {
        border-color: var(--accent);
        background: var(--accent-soft);
      }
      #failure-message {
        min-height: 1.25rem;
        margin: 0;
        color: var(--danger);
        font-size: 13px;
        visibility: ${failureVisibility};
      }
    </style>
    <script src="/oauth/hosted-login.js" defer></script>
  </head>
  <body>
    <form method="post" action="/oauth/login">
      <h1>Teddy Auth</h1>
      <p class="subtitle">Sign in to continue.</p>
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
      ${social.buttons}
      <a href="${signupHref}">sign up</a>
      <p id="failure-message" role="alert">${failureText}</p>
    </form>
    ${social.forms}
  </body>
</html>`;
  }

  renderAccountSelectionPage(
    request: AuthorizeRequestInput,
    loginTransaction: string,
    currentAccount?: { loginId: string | null; name: string },
    failureMessage = '',
  ) {
    const hiddenFields = this.hiddenInput(
      'login_transaction',
      loginTransaction,
    );
    const failureText = this.escapeHtml(failureMessage);
    const failureVisibility = failureText ? 'visible' : 'hidden';
    const social = this.renderSocialLogin(loginTransaction);
    const currentAccountForm = currentAccount
      ? `<form method="post" action="/oauth/login">
      ${hiddenFields}
      ${this.hiddenInput('account_selection', 'current')}
      <button class="current-account" type="submit">
        <span>${this.escapeHtml(currentAccount.name)}</span>
        <small>${this.escapeHtml(currentAccount.loginId ?? currentAccount.name)}</small>
      </button>
    </form>`
      : '';
    return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>계정 선택</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #eef1f5;
        --panel: #ffffff;
        --line: #d9dee7;
        --text: #151b28;
        --muted: #687386;
        --accent: #1d4ed8;
        --accent-soft: #e9efff;
        --danger: #b42318;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: var(--bg);
        color: var(--text);
      }
      main {
        width: min(380px, calc(100vw - 32px));
        display: grid;
        gap: 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        box-shadow: 0 18px 50px rgb(25 33 48 / 10%);
        padding: 22px;
      }
      form { display: grid; gap: 10px; }
      h1 { margin: 0; font-size: 21px; line-height: 1.2; }
      .subtitle, .divider {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
      }
      .divider { padding-top: 4px; font-weight: 700; }
      input, button {
        width: 100%;
        border-radius: 6px;
        font: inherit;
        outline: none;
      }
      input {
        border: 1px solid var(--line);
        color: var(--text);
        font-size: 16px;
        padding: 10px;
      }
      input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-soft);
      }
      button {
        min-height: 40px;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        cursor: pointer;
        font-size: 14px;
        font-weight: 700;
        padding: 9px 12px;
      }
      button:disabled {
        cursor: wait;
        opacity: 0.72;
      }
      .social-logins { display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 12px; }
      .social-logins button { font-weight: 600; padding: 0; height: 48px; display: grid; place-items: center; overflow: hidden; }
      .social-logins img { height: 48px; width: auto; max-width: 100%; object-fit: contain; }
      .social-google img { height: 40px; clip-path: inset(2px); }
      .social-google { background: #fff; color: #202124; border-color: #dadce0; }
      .social-kakao { background: #fee500; color: #191919; border-color: #fee500; }
      .social-naver { background: #03a94d; color: #fff; border-color: #03a94d; }
      .social-provider-form { display: none; }
      .current-account {
        display: grid;
        gap: 2px;
        background: var(--accent-soft);
        color: var(--accent);
        text-align: left;
      }
      .current-account small { color: var(--muted); font-weight: 500; }
      #failure-message {
        min-height: 1.25rem;
        margin: 0;
        color: var(--danger);
        font-size: 13px;
        visibility: ${failureVisibility};
      }
    </style>
    <script src="/oauth/hosted-login.js" defer></script>
  </head>
  <body>
    <main>
      <h1>계정 선택</h1>
      <p class="subtitle">이 요청에 사용할 계정을 선택하세요.</p>
      ${currentAccountForm}
      <p class="divider">다른 계정 사용</p>
      <form method="post" action="/oauth/login">
        ${hiddenFields}
        ${this.hiddenInput('account_selection', 'other')}
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
        <p id="failure-message" role="alert">${failureText}</p>
      </form>
      ${social.buttons}
    </main>
    ${social.forms}
  </body>
</html>`;
  }

  private renderSocialLogin(transaction: string) {
    const providers = this.socialProviders?.list() ?? [];
    if (!providers.length) return { buttons: '', forms: '' };
    const buttons = providers
      .map(({ key, label }) => {
        const assets: Record<string, string> = {
          google: 'google.png',
          kakao: 'kakao.svg',
          naver: 'naver.png',
        };
        const labels: Record<string, string> = {
          google: 'Google로 로그인',
          kakao: '카카오 로그인',
          naver: '네이버 로그인',
        };
        const name = this.escapeHtml(labels[key] ?? `${label}로 로그인`);
        const content = assets[key]
          ? `<img src="/oauth/social/assets/${assets[key]}" alt="" />`
          : name;
        return `<button class="social-${this.escapeHtml(key)}" aria-label="${name}" type="submit" form="social-login-${this.escapeHtml(key)}">${content}</button>`;
      })
      .join('');
    const forms = providers
      .map(
        ({ key }) =>
          `<form id="social-login-${this.escapeHtml(key)}" class="social-provider-form" data-social-login method="post" action="/oauth/login/social/${this.escapeHtml(key)}">${this.hiddenInput('login_transaction', transaction)}</form>`,
      )
      .join('');
    return { buttons: `<div class="social-logins">${buttons}</div>`, forms };
  }

  renderAuthorizationRedirectPage(redirectUrl: string) {
    const target = this.escapeHtml(redirectUrl);
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0;url=${target}" />
    <title>Continue</title>
  </head>
  <body>
    <a id="authorization-redirect" href="${target}">Continue</a>
  </body>
</html>`;
  }

  hostedPageContentSecurityPolicy(redirectUri: string) {
    const redirect = new URL(redirectUri);
    const redirectSource =
      redirect.origin === 'null' ? redirect.protocol : redirect.origin;
    return `default-src 'none'; script-src 'self'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self' ${redirectSource}; frame-ancestors 'none'; base-uri 'none'`;
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

  private buildSignupUrl(request: AuthorizeRequestInput): string {
    const authorizeParams = new URLSearchParams({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      response_type: request.responseType,
      scope: request.scope,
      code_challenge: request.codeChallenge,
      code_challenge_method: request.codeChallengeMethod,
    });
    if (request.state !== undefined) {
      authorizeParams.set('state', request.state);
    }
    if (request.nonce !== undefined) {
      authorizeParams.set('nonce', request.nonce);
    }
    if (request.prompt !== undefined) {
      authorizeParams.set('prompt', request.prompt);
    }
    const returnTo = `/oauth/authorize?${authorizeParams.toString()}`;
    const signupParams = new URLSearchParams({ return_to: returnTo });
    return `/signup?${signupParams.toString()}`;
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
