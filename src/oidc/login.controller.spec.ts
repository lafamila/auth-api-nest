import { UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthorizeFlowService } from './authorize-flow.service';
import { HostedLoginDto } from './dto/hosted-login.dto';
import { LoginController } from './login.controller';
import {
  AuthenticationMethod,
  KAKAO_GAME_DENIED_MESSAGE,
} from './authentication-method';

describe('Hosted login callback navigation', () => {
  function setup(
    prompt?: string,
    redirectUri = 'http://localhost:20022/api/todo/session/callback',
    options: {
      method?: AuthenticationMethod;
      category?: string;
      credentialVersion?: number;
    } = {},
  ) {
    const authorizeRequest = {
      clientId: 'todo-web',
      redirectUri,
      responseType: 'code',
      scope: 'openid profile email service.permission',
      state: 'original-state',
      codeChallenge: 'pkce-challenge',
      codeChallengeMethod: 'S256',
      prompt,
    };
    const account = {
      id: 'selected-account',
      status: 'active',
      credentialVersion: options.credentialVersion ?? 0,
    };
    const accounts = {
      authenticate: jest.fn().mockResolvedValue(account),
      findById: jest.fn(async (id: string) => ({ ...account, id })),
    };
    const codes = { create: jest.fn().mockResolvedValue('single-use-code') };
    const permissions = {
      findActiveOrCreateVisitorForFirstLogin: jest
        .fn()
        .mockResolvedValue({ status: 'active' }),
    };
    const flow = new AuthorizeFlowService(
      accounts as never,
      {
        findByClientId: jest.fn().mockResolvedValue({
          clientId: 'todo-web',
          status: 'active',
          serviceId: 'todo',
          service: { status: 'active', category: options.category },
          redirectUris: [authorizeRequest.redirectUri],
          requirePkce: true,
        }),
      } as never,
      permissions as never,
      codes as never,
    );
    const transaction = {
      request: authorizeRequest,
      sessionAccountId: prompt ? 'existing-account' : null,
    };
    const transactions = {
      cookieName: jest.fn().mockReturnValue('browser-binding'),
      find: jest.fn().mockResolvedValue(transaction),
      consume: jest.fn().mockResolvedValue(transaction),
    };
    const portal = { signOutKakao: jest.fn().mockResolvedValue(undefined) };
    const controller = new LoginController(
      accounts as never,
      flow,
      {} as never,
      transactions as never,
      portal as never,
      {
        context: async (request: Request) => {
          const id = (
            request.signedCookies as Record<string, string> | undefined
          )?.tas_session;
          return id
            ? {
                accountId: id,
                authenticationMethod: options.method ?? 'local',
                credentialVersion: options.credentialVersion ?? 0,
              }
            : null;
        },
        accountId: async (request: Request) =>
          (request.signedCookies as Record<string, string> | undefined)
            ?.tas_session ?? null,
        create: async (value: { id: string }, response: Response) => {
          response.cookie('tas_session', value.id, {
            httpOnly: true,
            signed: true,
          });
        },
      } as never,
    );
    const response = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      cookie: jest.fn().mockReturnThis(),
      clearCookie: jest.fn().mockReturnThis(),
      redirect: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const request = {
      signedCookies: {
        'browser-binding': 'browser-nonce',
        ...(prompt ? { tas_session: 'existing-account' } : {}),
      },
    } as unknown as Request;
    const body: HostedLoginDto = {
      login_transaction: 'transaction-id',
      loginId: 'fixture-user',
      password: 'fixture-password!',
    };
    return {
      controller,
      accounts,
      codes,
      permissions,
      transactions,
      request,
      response,
      body,
      authorizeRequest,
      portal,
    };
  }

  it('ends the login POST before navigating through a different-port callback', async () => {
    const { controller, request, response, body, transactions } = setup();

    await controller.hostedLogin(
      body,
      request,
      response as unknown as Response,
    );

    expect(transactions.consume).toHaveBeenCalledWith(
      'transaction-id',
      'browser-nonce',
    );
    expect(response.cookie).toHaveBeenCalledWith(
      'tas_session',
      'selected-account',
      expect.objectContaining({ httpOnly: true, signed: true }),
    );
    expect(response.redirect).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.type).toHaveBeenCalledWith('html');
    expect(response.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': expect.stringContaining(
          "form-action 'self' http://localhost:20022",
        ),
      }),
    );
    expect(response.send).toHaveBeenCalledWith(
      expect.stringContaining(
        'http://localhost:20022/api/todo/session/callback?code=single-use-code&amp;state=original-state',
      ),
    );
    expect(response.send).toHaveBeenCalledWith(
      expect.stringContaining('http-equiv="refresh"'),
    );
  });

  it.each(['current', 'other'] as const)(
    'uses the same navigation for %s account selection without replacing SSO',
    async (selection) => {
      const { controller, request, response, body } = setup('select_account');

      await controller.hostedLogin(
        { ...body, account_selection: selection },
        request,
        response as unknown as Response,
      );

      expect(response.redirect).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(200);
      expect(response.send).toHaveBeenCalledWith(
        expect.stringContaining('http-equiv="refresh"'),
      );
      expect(response.cookie).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['local', 'game', 0],
    ['google', 'game', 7],
    ['naver', 'game', 7],
    ['kakao', 'productivity', 7],
    ['legacy', 'productivity', 0],
  ] as const)(
    'rejects current %s SSO for %s when its authenticated version is bumped',
    async (method, category, credentialVersion) => {
      const f = setup('select_account', undefined, {
        method,
        category,
        credentialVersion,
      });
      f.accounts.findById.mockResolvedValue({
        id: 'existing-account',
        status: 'active',
        credentialVersion: credentialVersion + 1,
      });

      await f.controller.hostedLogin(
        { ...f.body, account_selection: 'current' },
        f.request,
        f.response as unknown as Response,
      );

      expect(f.response.status).toHaveBeenCalledWith(403);
      expect(f.response.json).toHaveBeenCalledWith({
        error: 'access_denied',
        error_description: 'Account credential state has changed',
      });
      expect(
        f.permissions.findActiveOrCreateVisitorForFirstLogin,
      ).not.toHaveBeenCalled();
      expect(f.codes.create).not.toHaveBeenCalled();
      expect(f.accounts.authenticate).not.toHaveBeenCalled();
      expect(f.response.cookie).not.toHaveBeenCalled();
      expect(f.portal.signOutKakao).not.toHaveBeenCalled();
    },
  );

  it('uses an unchanged nonzero SSO version for current-account authorization', async () => {
    const f = setup('select_account', undefined, {
      method: 'google',
      category: 'game',
      credentialVersion: 7,
    });

    await f.controller.hostedLogin(
      { ...f.body, account_selection: 'current' },
      f.request,
      f.response as unknown as Response,
    );

    expect(f.codes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'existing-account',
        authenticationMethod: 'google',
        credentialVersion: 7,
      }),
    );
    expect(f.response.status).toHaveBeenCalledWith(200);
    expect(f.response.cookie).not.toHaveBeenCalled();
  });

  it('uses fresh credentials rather than the SSO version for other-account selection', async () => {
    const f = setup('select_account', undefined, {
      method: 'google',
      credentialVersion: 7,
    });
    const account = {
      id: 'selected-account',
      status: 'active',
      credentialVersion: 12,
    };
    f.accounts.authenticate.mockResolvedValue(account);
    f.accounts.findById.mockResolvedValue(account);

    await f.controller.hostedLogin(
      { ...f.body, account_selection: 'other' },
      f.request,
      f.response as unknown as Response,
    );

    expect(f.codes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'selected-account',
        authenticationMethod: 'local',
        credentialVersion: 12,
      }),
    );
    expect(f.response.status).toHaveBeenCalledWith(200);
    expect(f.response.cookie).not.toHaveBeenCalled();
  });

  it('uses the navigation page for a validated OAuth error too', async () => {
    const { controller, request, response, body } = setup('unsupported');

    await controller.hostedLogin(
      body,
      request,
      response as unknown as Response,
    );

    expect(response.redirect).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith(
      expect.stringContaining('error=invalid_request'),
    );
  });

  it('preserves HTTP redirects for native authentication callbacks', async () => {
    const { controller, request, response, body } = setup(
      undefined,
      'xyz.lafamila.not:/oauth/callback',
    );

    await controller.hostedLogin(
      body,
      request,
      response as unknown as Response,
    );

    expect(response.redirect).toHaveBeenCalledWith(
      'xyz.lafamila.not:/oauth/callback?code=single-use-code&state=original-state',
    );
    expect(response.send).not.toHaveBeenCalled();
  });

  it('keeps wrong credentials on the retryable form without issuing a code', async () => {
    const {
      controller,
      request,
      response,
      body,
      accounts,
      codes,
      transactions,
    } = setup();
    accounts.authenticate.mockRejectedValue(
      new UnauthorizedException('Invalid credentials'),
    );

    await controller.hostedLogin(
      body,
      request,
      response as unknown as Response,
    );

    expect(transactions.consume).not.toHaveBeenCalled();
    expect(codes.create).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
    expect(response.send).toHaveBeenCalledWith(
      expect.stringContaining('Invalid credentials'),
    );
    expect(response.send).toHaveBeenCalledWith(
      expect.not.stringContaining('http-equiv="refresh"'),
    );
  });

  it('uses local credentials for P2 even while P1 is Kakao, without logging P1 out', async () => {
    const f = setup('select_account', undefined, {
      method: 'kakao',
      category: 'game',
    });
    await f.controller.hostedLogin(
      { ...f.body, account_selection: 'other' },
      f.request,
      f.response as unknown as Response,
    );
    expect(f.codes.create).toHaveBeenCalledWith(
      expect.objectContaining({ authenticationMethod: 'local' }),
    );
    expect(f.response.cookie).not.toHaveBeenCalled();
    expect(f.portal.signOutKakao).not.toHaveBeenCalled();
  });

  it('uses current selection provenance and shows the exact policy message before callback', async () => {
    const f = setup('select_account', undefined, {
      method: 'kakao',
      category: 'game',
    });
    await f.controller.hostedLogin(
      { ...f.body, account_selection: 'current' },
      f.request,
      f.response as unknown as Response,
    );
    expect(f.codes.create).not.toHaveBeenCalled();
    expect(f.portal.signOutKakao).toHaveBeenCalledWith(
      'existing-account',
      f.request,
      f.response,
    );
    expect(f.response.send).toHaveBeenCalledWith(
      expect.stringContaining(KAKAO_GAME_DENIED_MESSAGE),
    );
    expect(f.response.send).toHaveBeenCalledWith(
      expect.stringContaining('content="3;url='),
    );
  });

  it('cannot upgrade legacy current selection with browser-submitted method fields', async () => {
    const f = setup('select_account', undefined, {
      method: 'legacy',
      category: 'game',
    });
    await f.controller.hostedLogin(
      {
        ...f.body,
        account_selection: 'current',
        authenticationMethod: 'local',
      } as HostedLoginDto,
      f.request,
      f.response as unknown as Response,
    );
    expect(f.codes.create).not.toHaveBeenCalled();
    expect(f.portal.signOutKakao).not.toHaveBeenCalled();
  });
});
