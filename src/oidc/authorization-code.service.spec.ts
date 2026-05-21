import { AuthorizationCodeService } from './authorization-code.service';

describe('AuthorizationCodeService', () => {
  it('consumes authorization codes only once', () => {
    const service = new AuthorizationCodeService();
    const code = service.create({
      accountId: 'account-1',
      clientId: 'client-1',
      redirectUri: 'http://localhost/callback',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      scope: 'openid',
    });

    expect(service.consume(code)?.accountId).toBe('account-1');
    expect(service.consume(code)).toBeNull();
  });
});
