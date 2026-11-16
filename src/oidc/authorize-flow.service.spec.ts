import { AccountPermissionsService } from '../domain/account-permissions/account-permissions.service';
import { AccountsService } from '../domain/accounts/accounts.service';
import { OidcClientsService } from '../domain/oidc-clients/oidc-clients.service';
import { AuthorizationCodeService } from './authorization-code.service';
import { SocialProvidersService } from '../social/social-providers.service';
import {
  AuthorizeFlowService,
  AuthorizeRequestInput,
  SELECT_ACCOUNT_PROMPT,
} from './authorize-flow.service';

describe('AuthorizeFlowService prompt handling', () => {
  const client = {
    clientId: 'gbc-porting-web',
    status: 'active',
    serviceId: 'gbc-porting-service-id',
    service: { status: 'active' },
    redirectUris: ['https://play.example.com/session/oidc/callback'],
    requirePkce: true,
  };
  const request: AuthorizeRequestInput = {
    clientId: client.clientId,
    redirectUri: client.redirectUris[0],
    responseType: 'code',
    scope: 'openid profile email service.permission',
    state: 'player-2-state',
    nonce: 'appauth-generated-nonce',
    codeChallenge: 'pkce-challenge',
    codeChallengeMethod: 'S256',
  };
  let service: AuthorizeFlowService;

  beforeEach(() => {
    service = new AuthorizeFlowService(
      {} as AccountsService,
      {
        findByClientId: jest.fn().mockResolvedValue(client),
      } as unknown as OidcClientsService,
      {} as AccountPermissionsService,
      {} as AuthorizationCodeService,
    );
  });

  it('preserves the supported select_account prompt in a validated request', async () => {
    await expect(
      service.validateRequest({
        ...request,
        prompt: SELECT_ACCOUNT_PROMPT,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: 'validated',
        request: expect.objectContaining({
          prompt: SELECT_ACCOUNT_PROMPT,
          nonce: 'appauth-generated-nonce',
        }),
      }),
    );
  });

  it('rejects invalid nonce values before starting hosted login', async () => {
    await expect(
      service.validateRequest({ ...request, nonce: 'invalid\nnonce' }),
    ).rejects.toMatchObject({
      error: 'invalid_request',
      errorDescription: 'Invalid nonce',
    });
  });

  it.each([
    'login',
    'none',
    'select_account login',
    'select_account select_account',
    '',
  ])('rejects unsupported prompt value or combination %j', async (prompt) => {
    const result = await service.validateRequest({ ...request, prompt });

    expect(result.kind).toBe('redirect');
    if (result.kind !== 'redirect') {
      throw new Error('Expected an OAuth error redirect');
    }
    const redirect = new URL(result.redirectUrl);
    expect(redirect.searchParams.get('error')).toBe('invalid_request');
    expect(redirect.searchParams.get('state')).toBe(request.state);
  });

  it('requires openid as an exact scope token', async () => {
    await expect(
      service.validateRequest({ ...request, scope: 'profile notopenid' }),
    ).rejects.toMatchObject({
      error: 'invalid_request',
      errorDescription: 'Missing required authorize parameters',
    });
  });

  it('requires S256 PKCE for public clients even if legacy config disabled it', async () => {
    const legacyPublicClient = {
      ...client,
      clientType: 'public',
      requirePkce: false,
    };
    service = new AuthorizeFlowService(
      {} as AccountsService,
      {
        findByClientId: jest.fn().mockResolvedValue(legacyPublicClient),
      } as unknown as OidcClientsService,
      {} as AccountPermissionsService,
      {} as AuthorizationCodeService,
    );

    const result = await service.validateRequest({
      ...request,
      codeChallengeMethod: 'plain',
    });

    expect(result.kind).toBe('redirect');
    if (result.kind !== 'redirect') {
      throw new Error('Expected an OAuth error redirect');
    }
    expect(new URL(result.redirectUrl).searchParams.get('error')).toBe(
      'invalid_request',
    );
  });

  it('allows the validated callback destination in hosted form navigation', () => {
    expect(
      service.hostedPageContentSecurityPolicy(request.redirectUri),
    ).toContain("form-action 'self' https://play.example.com");
    expect(
      service.hostedPageContentSecurityPolicy('bodylab://auth/callback'),
    ).toContain("form-action 'self' bodylab:");
  });

  it('passes the account credential version observed before code creation', async () => {
    const account = {
      id: 'account-1',
      status: 'active',
      passwordResetRequired: false,
      credentialVersion: 12,
    };
    const codes = {
      create: jest.fn().mockResolvedValue('one-time-code'),
    };
    service = new AuthorizeFlowService(
      { findById: jest.fn().mockResolvedValue(account) } as never,
      {} as never,
      {
        findActiveOrCreateVisitorForFirstLogin: jest
          .fn()
          .mockResolvedValue({ status: 'active' }),
      } as never,
      codes as unknown as AuthorizationCodeService,
    );

    await service.authorizeWithAccount(
      { kind: 'validated', client, request } as never,
      account.id,
    );

    expect(codes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: account.id,
        credentialVersion: 12,
      }),
    );
  });

  it('rejects a mismatched credential version before permission or code issuance', async () => {
    const account = {
      id: 'account-1',
      status: 'active',
      passwordResetRequired: false,
      credentialVersion: undefined,
    };
    const accountPermissions = {
      findActiveOrCreateVisitorForFirstLogin: jest.fn(),
    };
    const codes = { create: jest.fn() };
    service = new AuthorizeFlowService(
      { findById: jest.fn().mockResolvedValue(account) } as never,
      {} as never,
      accountPermissions as unknown as AccountPermissionsService,
      codes as unknown as AuthorizationCodeService,
    );

    await expect(
      service.authorizeWithAccount(
        { kind: 'validated', client, request } as never,
        account.id,
        1,
      ),
    ).rejects.toMatchObject({ error: 'access_denied' });
    expect(
      accountPermissions.findActiveOrCreateVisitorForFirstLogin,
    ).not.toHaveBeenCalled();
    expect(codes.create).not.toHaveBeenCalled();
  });

  it('creates a code with version zero when a legacy account matches', async () => {
    const account = {
      id: 'account-1',
      status: 'active',
      passwordResetRequired: false,
      credentialVersion: undefined,
    };
    const accountPermissions = {
      findActiveOrCreateVisitorForFirstLogin: jest
        .fn()
        .mockResolvedValue({ status: 'active' }),
    };
    const codes = {
      create: jest.fn().mockResolvedValue('one-time-code'),
    };
    service = new AuthorizeFlowService(
      { findById: jest.fn().mockResolvedValue(account) } as never,
      {} as never,
      accountPermissions as unknown as AccountPermissionsService,
      codes as unknown as AuthorizationCodeService,
    );

    await service.authorizeWithAccount(
      { kind: 'validated', client, request } as never,
      account.id,
      0,
    );

    expect(
      accountPermissions.findActiveOrCreateVisitorForFirstLogin,
    ).toHaveBeenCalledTimes(1);
    expect(codes.create).toHaveBeenCalledWith(
      expect.objectContaining({ credentialVersion: 0 }),
    );
  });

  it('renders selection actions without exposing an account id', () => {
    const html = service.renderAccountSelectionPage(
      { ...request, prompt: SELECT_ACCOUNT_PROMPT },
      'login-transaction',
      { loginId: 'player-one', name: 'Player One' },
    );

    expect(html).not.toContain('name="prompt"');
    expect(html).not.toContain('name="client_id"');
    expect(html).not.toContain('name="redirect_uri"');
    expect(html).not.toContain('name="state"');
    expect(html).not.toContain('name="code_challenge"');
    expect(html).toContain('name="account_selection" value="current"');
    expect(html).toContain('name="account_selection" value="other"');
    expect(html).toContain(
      'name="login_transaction" value="login-transaction"',
    );
    expect(html).toContain('src="/oauth/hosted-login.js"');
    expect(html).toContain('Player One');
    expect(html).toContain('player-one');
    expect(html).not.toContain('account_id');
  });

  it.each([
    'http://localhost:20022/api/todo/session/callback',
    'https://todo.example.com/auth/callback',
  ])('renders independent callback navigation for %s', (callback) => {
    const html = service.renderAuthorizationRedirectPage(
      `${callback}?code=one-time-code&state=original-state`,
    );

    expect(html).toContain(
      `<meta http-equiv="refresh" content="0;url=${callback}?code=one-time-code&amp;state=original-state"`,
    );
    expect(html).toContain(
      `id="authorization-redirect" href="${callback}?code=one-time-code&amp;state=original-state"`,
    );
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<script');
  });

  it('escapes callback content in both navigation targets', () => {
    const html = service.renderAuthorizationRedirectPage(
      'https://todo.example.com/callback?state="/><script>alert(1)</script>&code=test',
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;/&gt;&lt;script&gt;');
    expect(html).toContain('&amp;code=test');
  });

  it('binds configured social buttons to separate credential-free forms', () => {
    const providers = {
      list: () => [
        { key: 'google', label: 'Google' },
        { key: 'kakao', label: 'Kakao' },
        { key: 'naver', label: 'Naver' },
      ],
    };
    service = new AuthorizeFlowService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      providers as SocialProvidersService,
    );
    const html = service.renderHostedLoginPage(
      request,
      'browser-bound-transaction',
    );
    for (const key of ['google', 'kakao', 'naver']) {
      expect(html).toContain(`form="social-login-${key}"`);
      expect(html).toContain(`action="/oauth/login/social/${key}"`);
      expect(html).toContain(`/oauth/social/assets/${key}.`);
    }
    const socialForms = html.match(/<form id="social-login-[\s\S]+?<\/form>/g)!;
    expect(socialForms).toHaveLength(3);
    for (const form of socialForms) {
      expect(form).toContain(
        'name="login_transaction" value="browser-bound-transaction"',
      );
      expect(form).not.toContain('name="password"');
      expect(form).not.toContain('name="loginId"');
    }
  });

  it('renders account selection for a social-only SSO account', () => {
    const html = service.renderAccountSelectionPage(request, 'transaction', {
      loginId: null,
      name: 'Social User',
    });
    expect(html).toContain('Social User');
    expect(html).not.toContain('<small>null</small>');
  });
});
