import {
  ConflictException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { Request, Response } from 'express';
import { AppConfigService } from '../src/config/app-config.service';
import {
  authenticationMethod,
  KAKAO_GAME_DENIED_MESSAGE,
} from '../src/oidc/authentication-method';
import { AuthorizeFlowService } from '../src/oidc/authorize-flow.service';
import { HostedLoginTransactionService } from '../src/oidc/hosted-login-transaction.service';
import { SsoSessionService } from '../src/oidc/sso-session.service';
import { PortalAuthService } from '../src/portal/portal-auth.service';
import { PortalSessionService } from '../src/portal/portal-session.service';
import { PublicSiteService } from '../src/public-site/public-site.service';
import { SocialLoginController } from '../src/social/social-login.controller';
import { SocialLoginService } from '../src/social/social-login.service';
import { SocialProvidersService } from '../src/social/social-providers.service';

// HTTP/controller integration only: no AppModule, DataSource, migrations or workers.
// Persistent SQL/concurrency tests remain subject to the coordinator's DB gate.
describe('Game login policy (offline HTTP integration)', () => {
  const secret = 'game-policy-http-test-cookie-secret';
  const account = {
    id: 'authenticated-account',
    status: 'active',
    credentialVersion: 0,
  };
  const callback = 'https://registered.example.test/callback';
  const authorize = {
    clientId: 'registered-client',
    redirectUri: callback,
    responseType: 'code',
    scope: 'openid',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
    state: 'original-state',
    nonce: 'nonce',
  };
  let app: INestApplication;
  let category = 'game';
  let consumed = false;
  let context: { accountId: string; authenticationMethod: string } | null =
    null;
  let savedSessionAccountId: string | null = null;
  let redirectUri = callback;
  const codes = { create: jest.fn().mockResolvedValue('one-time-code') };
  const sso = {
    context: jest.fn(async () => context),
    accountId: jest.fn(async () => context?.accountId ?? null),
    create: jest.fn(),
  };
  const portal = { signOutKakao: jest.fn(), completePrimary: jest.fn() };
  const config = {
    nodeEnv: 'test',
    issuerUrl: 'https://auth.example.test',
    adminSessionCookieName: 'tas_admin',
    socialProviderCredentials: (provider: string) => ({
      clientId: `${provider}-client`,
      clientSecret: `${provider}-secret`,
    }),
  } as AppConfigService;
  const providers = new SocialProvidersService(config, {} as never);
  const exchange = jest
    .spyOn(providers, 'exchangeCode')
    .mockImplementation(async (provider) => ({
      provider,
      providerClientId: `${provider}-client`,
      subject: 'provider-subject-must-not-leak',
      email: 'private@example.test',
      emailVerified: true,
      name: 'Private Person',
    }));
  const hosted = {
    cookieName: () => 'login-binding',
    find: jest.fn(async () =>
      consumed
        ? null
        : {
            request: { ...authorize, redirectUri },
            sessionAccountId: savedSessionAccountId,
          },
    ),
    consume: jest.fn(async () => {
      if (consumed) return null;
      consumed = true;
      return { request: authorize, sessionAccountId: savedSessionAccountId };
    }),
  };
  const social = {
    cookieName: () => 'social-binding',
    start: jest.fn(async () => ({
      state: 'social-state',
      binding: 'browser',
      authorizationUrl:
        'https://kauth.kakao.com/oauth/authorize?state=social-state',
    })),
    callback: jest.fn(async (provider: string) => {
      const profile = await providers.exchangeCode(provider, {
        code: 'offline-code',
        state: 'social-state',
        codeVerifier: 'a'.repeat(43),
      });
      return {
        kind: 'authenticated',
        account,
        request: { ...authorize },
        authenticationMethod: authenticationMethod(profile.provider),
      };
    }),
    signupPage: jest.fn(async () => ({
      transaction: 'social-state',
      email: 'private@example.test',
      emailVerified: true,
      name: 'Private Person',
    })),
  };
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeAll(async () => {
    const publicSite = new PublicSiteService(new ConfigService());
    const flow = new AuthorizeFlowService(
      { findById: async () => account } as never,
      {
        findByClientId: async () => ({
          clientId: authorize.clientId,
          status: 'active',
          clientType: 'public',
          serviceId: 'service',
          service: { category, status: 'active' },
          redirectUris: [callback],
          requirePkce: true,
        }),
      } as never,
      {
        findActiveOrCreateVisitorForFirstLogin: async () => ({
          status: 'active',
        }),
      } as never,
      codes as never,
      providers,
      publicSite,
    );
    const module = await Test.createTestingModule({
      controllers: [SocialLoginController],
      providers: [
        { provide: SocialLoginService, useValue: social },
        { provide: SocialProvidersService, useValue: providers },
        { provide: HostedLoginTransactionService, useValue: hosted },
        { provide: AuthorizeFlowService, useValue: flow },
        { provide: AppConfigService, useValue: config },
        { provide: PortalAuthService, useValue: portal },
        {
          provide: PortalSessionService,
          useValue: { fingerprint: () => null },
        },
        { provide: SsoSessionService, useValue: sso },
        { provide: PublicSiteService, useValue: publicSite },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(cookieParser(secret));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    category = 'game';
    consumed = false;
    context = null;
    savedSessionAccountId = null;
    redirectUri = callback;
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('No provider HTTP in this test'));
  });
  afterEach(() => {
    if (!fetchSpy) return;
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  afterAll(async () => {
    exchange.mockRestore();
    await app?.close();
  });

  it('rejects anonymous Kakao game starts before contacting or redirecting to the provider', async () => {
    const response = await request(app.getHttpServer())
      .post('/oauth/login/social/kakao')
      .set('Cookie', cookie('login-binding'))
      .send({ login_transaction: 'hosted-transaction' })
      .expect(200);
    expect(response.text).toContain(KAKAO_GAME_DENIED_MESSAGE);
    expect(response.text).toContain('content="3;url=');
    expect(response.text).toContain('error=access_denied');
    expect(response.text).toContain(
      'error_code=AUTHENTICATION_METHOD_NOT_ALLOWED',
    );
    expect(response.text).toContain('state=original-state');
    expect(response.text).toContain(callback);
    expect(response.text).toContain('/brand/');
    expect(response.headers['content-security-policy']).toContain(
      "img-src 'self'",
    );
    expect(response.headers['content-security-policy']).toContain(
      "style-src 'self'",
    );
    expect(social.start).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
    expect(sso.create).not.toHaveBeenCalled();
    expect(codes.create).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .post('/oauth/login/social/kakao')
      .set('Cookie', cookie('login-binding'))
      .send({ login_transaction: 'hosted-transaction' })
      .expect(400);
  });

  it('rechecks policy after an offline Kakao callback without leaking provider profile or issuing a session', async () => {
    const response = await request(app.getHttpServer())
      .get('/oauth/social/kakao/callback')
      .set('Cookie', cookie('social-binding'))
      .query({
        state: 'social-state',
        code: 'offline-code',
        authentication_method: 'local',
      })
      .expect(200);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(response.text).toContain(KAKAO_GAME_DENIED_MESSAGE);
    expect(response.text).not.toMatch(
      /provider-subject-must-not-leak|private@example.test|Private Person/,
    );
    expect(sso.create).not.toHaveBeenCalled();
    expect(codes.create).not.toHaveBeenCalled();
    expect(portal.signOutKakao).toHaveBeenCalledWith(
      account.id,
      expect.anything(),
      expect.anything(),
    );
  });

  it('allows non-game Kakao and stamps its real provider method on the issued code and SSO', async () => {
    category = 'productivity';
    await request(app.getHttpServer())
      .post('/oauth/login/social/kakao')
      .set('Cookie', cookie('login-binding'))
      .send({ login_transaction: 'hosted-transaction' })
      .expect(200);
    expect(social.start).toHaveBeenCalled();
    await request(app.getHttpServer())
      .get('/oauth/social/kakao/callback')
      .set('Cookie', cookie('social-binding'))
      .query({ state: 'social-state', code: 'offline-code' })
      .expect(200);
    expect(codes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticationMethod: 'kakao',
        nonce: 'nonce',
      }),
    );
    expect(sso.create).toHaveBeenCalledWith(
      account,
      expect.anything(),
      'kakao',
    );
    expect(portal.signOutKakao).not.toHaveBeenCalled();
  });

  it('allows Google game authentication even when the same account has a Kakao connection', async () => {
    await request(app.getHttpServer())
      .get('/oauth/social/google/callback')
      .set('Cookie', cookie('social-binding'))
      .query({ state: 'social-state', code: 'offline-code' })
      .expect(200);
    expect(codes.create).toHaveBeenCalledWith(
      expect.objectContaining({ authenticationMethod: 'google' }),
    );
    expect(sso.create).toHaveBeenCalledWith(
      account,
      expect.anything(),
      'google',
    );
    expect(portal.signOutKakao).not.toHaveBeenCalled();
  });

  it('does not log out unrelated local SSO when anonymous/secondary Kakao is denied', async () => {
    context = {
      accountId: 'unrelated-local-account',
      authenticationMethod: 'local',
    };
    savedSessionAccountId = context.accountId;
    await request(app.getHttpServer())
      .post('/oauth/login/social/kakao')
      .set('Cookie', cookie('login-binding'))
      .send({ login_transaction: 'hosted-transaction' })
      .expect(200);
    expect(portal.signOutKakao).not.toHaveBeenCalled();
    expect(sso.create).not.toHaveBeenCalled();
  });

  it('never redirects a policy error to an unregistered callback', async () => {
    redirectUri = 'https://unregistered.example.test/callback';
    const response = await request(app.getHttpServer())
      .post('/oauth/login/social/kakao')
      .set('Cookie', cookie('login-binding'))
      .send({ login_transaction: 'hosted-transaction' })
      .expect(400);
    expect(response.text).not.toContain(redirectUri);
    expect(social.start).not.toHaveBeenCalled();
  });

  it('decorates raw social signup and error pages with same-origin branding', async () => {
    const signup = await request(app.getHttpServer())
      .get('/oauth/social/signup')
      .set('Cookie', cookie('social-binding'))
      .query({ transaction: 'social-state' })
      .expect(200);
    expect(signup.text).toContain('data-auth-site-layout="form"');
    expect(signup.text).toContain('/public/assets/site.css');
    const error = await request(app.getHttpServer())
      .get('/oauth/social/signup')
      .query({ transaction: 'social-state' })
      .expect(400);
    expect(error.text).toContain('/brand/');
    expect(error.text).toContain('/privacy');
  });

  function cookie(name: string): string {
    const value = 'browser';
    const signature = createHmac('sha256', secret)
      .update(value)
      .digest('base64')
      .replace(/=+$/, '');
    return `${name}=${encodeURIComponent(`s:${value}.${signature}`)}`;
  }
});

describe('Social completion error statuses (no HTTP or DB)', () => {
  it.each([true, false])(
    'returns a sanitized 500 for persistence failures when signup page reload is %s',
    async (reloadPage) => {
      const failure = new Error(
        'private SQL persistence details must not reach the browser',
      );
      const f = setup(failure, reloadPage);
      await f.controller.complete(
        { transaction: 'social-state' } as never,
        f.request,
        f.response as unknown as Response,
      );
      expect(f.response.status).toHaveBeenCalledWith(500);
      expect(f.response.send).toHaveBeenCalledWith(
        expect.stringContaining('Social login failed'),
      );
      expect(f.response.send).toHaveBeenCalledWith(
        expect.not.stringContaining(failure.message),
      );
    },
  );

  it.each([true, false])(
    'preserves explicit HTTP exception statuses when signup page reload is %s',
    async (reloadPage) => {
      const f = setup(
        new ConflictException('Account is already linked'),
        reloadPage,
      );
      await f.controller.complete(
        { transaction: 'social-state' } as never,
        f.request,
        f.response as unknown as Response,
      );
      expect(f.response.status).toHaveBeenCalledWith(409);
      expect(f.response.send).toHaveBeenCalledWith(
        expect.stringContaining('Account is already linked'),
      );
    },
  );

  function setup(failure: Error, reloadPage: boolean) {
    const social = {
      cookieName: () => 'social-binding',
      complete: jest.fn().mockRejectedValue(failure),
      signupPage: reloadPage
        ? jest.fn().mockResolvedValue({
            transaction: 'social-state',
            email: 'private@example.test',
            emailVerified: true,
            name: 'Private Person',
          })
        : jest.fn().mockRejectedValue(new Error('Cannot reload page')),
    };
    const controller = new SocialLoginController(
      social as never,
      {} as never,
      {} as never,
      {} as never,
      {
        nodeEnv: 'test',
        adminSessionCookieName: 'tas_admin',
      } as AppConfigService,
      {} as never,
      { fingerprint: () => null } as never,
      { accountId: async () => null } as never,
    );
    const response = {
      set: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };
    const request = {
      signedCookies: { 'social-binding': 'browser' },
    } as unknown as Request;
    return { controller, response, request };
  }
});
