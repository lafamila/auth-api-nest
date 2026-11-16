import { UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthorizeFlowService } from './authorize-flow.service';
import { HostedLoginDto } from './dto/hosted-login.dto';
import { LoginController } from './login.controller';

describe('Hosted login callback navigation', () => {
  function setup(
    prompt?: string,
    redirectUri = 'http://localhost:20022/api/todo/session/callback',
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
    const account = { id: 'selected-account', status: 'active' };
    const accounts = {
      authenticate: jest.fn().mockResolvedValue(account),
      findById: jest.fn().mockResolvedValue(account),
    };
    const codes = { create: jest.fn().mockResolvedValue('single-use-code') };
    const flow = new AuthorizeFlowService(
      accounts as never,
      {
        findByClientId: jest.fn().mockResolvedValue({
          clientId: 'todo-web',
          status: 'active',
          serviceId: 'todo',
          service: { status: 'active' },
          redirectUris: [authorizeRequest.redirectUri],
          requirePkce: true,
        }),
      } as never,
      {
        findActiveOrCreateVisitorForFirstLogin: jest
          .fn()
          .mockResolvedValue({ status: 'active' }),
      } as never,
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
    const controller = new LoginController(
      accounts as never,
      flow,
      {} as never,
      transactions as never,
      {} as never,
      {
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
      transactions,
      request,
      response,
      body,
      authorizeRequest,
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
});
