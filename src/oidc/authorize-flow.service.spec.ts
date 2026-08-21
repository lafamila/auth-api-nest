import { AccountPermissionsService } from '../domain/account-permissions/account-permissions.service';
import { AccountsService } from '../domain/accounts/accounts.service';
import { OidcClientsService } from '../domain/oidc-clients/oidc-clients.service';
import { AuthorizationCodeService } from './authorization-code.service';
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
        request: expect.objectContaining({ prompt: SELECT_ACCOUNT_PROMPT }),
      }),
    );
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

  it('allows the validated callback destination in hosted form navigation', () => {
    expect(service.hostedPageContentSecurityPolicy(request.redirectUri)).toContain(
      "form-action 'self' https://play.example.com",
    );
    expect(service.hostedPageContentSecurityPolicy('bodylab://auth/callback')).toContain(
      "form-action 'self' bodylab:",
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
});
