import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { TotpService } from '../src/common/crypto/totp.service';
import { AccountServicePermissionEntity } from '../src/database/entities/account-service-permission.entity';
import { AccountEntity } from '../src/database/entities/account.entity';
import { OidcClientEntity } from '../src/database/entities/oidc-client.entity';
import { ServiceCredentialEntity } from '../src/database/entities/service-credential.entity';
import { ServiceOnboardingRequestEntity } from '../src/database/entities/service-onboarding-request.entity';
import { ServicePermissionDefinitionEntity } from '../src/database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../src/database/entities/service.entity';
import { AccountsService } from '../src/domain/accounts/accounts.service';
import { ServiceApplicationsService } from '../src/domain/service-applications/service-applications.service';
import { ServiceOnboardingService } from '../src/domain/service-onboarding/service-onboarding.service';
import { TokenService } from '../src/oidc/token.service';
import { hashToken } from '../src/common/crypto/token-hash';

interface ApprovedServiceResult {
  approval: {
    request: {
      id: string;
      serviceKey: string;
      kind: string;
    };
    secrets: Array<Record<string, unknown>>;
  };
  permissionsByKey: Map<string, ServicePermissionDefinitionEntity>;
  service: ServiceEntity;
}

describe('App bootstrap (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminCookie: string[];
  let bootstrapCompleteBody: Record<string, unknown>;
  let uniqueCounter = 0;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL =
      process.env.TEST_DATABASE_URL ??
      'postgres://postgres:postgres@localhost:35432/teddy_auth';
    process.env.COOKIE_SECRET = 'test-cookie-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser(process.env.COOKIE_SECRET));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    dataSource = app.get(DataSource);
    adminCookie = await createAdminSessionCookie();
  });

  afterAll(async () => {
    await app?.close();
  });

  function nextSuffix(label: string) {
    uniqueCounter += 1;
    return `${label}-${Date.now()}-${uniqueCounter}`;
  }

  async function createAdminSessionCookie(): Promise<string[]> {
    const suffix = nextSuffix('superadmin-e2e');
    const loginId = suffix;
    const password = 'Superadmin-password!';
    const totp = app.get(TotpService);

    await dataSource
      .getRepository(AccountEntity)
      .update({ isSuperAdmin: true, status: 'active' }, { status: 'disabled' });

    await request(app.getHttpServer())
      .get('/api/admin/bootstrap/status')
      .expect(200)
      .expect((response) => {
        expect(response.body.requiresBootstrap).toBe(true);
      });

    const startResponse = await request(app.getHttpServer())
      .post('/api/admin/bootstrap/start')
      .send({
        loginId,
        name: 'E2E Super Admin',
        email: `${loginId}@lafamila.xyz`,
        password,
      })
      .expect(201);

    const otpCode = (
      totp as unknown as { generateCode(secret: string, now: number): string }
    ).generateCode(startResponse.body.otpSecret, Date.now());

    const completeResponse = await request(app.getHttpServer())
      .post('/api/admin/bootstrap/complete')
      .send({ challengeId: startResponse.body.challengeId, otpCode })
      .expect(201);

    bootstrapCompleteBody = completeResponse.body;
    const setCookie = completeResponse.headers['set-cookie'];
    return Array.isArray(setCookie) ? setCookie : [setCookie];
  }

  async function createAccount(
    input?: Partial<{
      loginId: string;
      email: string;
      name: string;
      password: string;
    }>,
  ) {
    const suffix = nextSuffix('user');
    const password = input?.password ?? 'Test-password-1234!';
    const accounts = app.get(AccountsService);
    const account = await accounts.create(
      {
        loginId: input?.loginId ?? suffix,
        name: input?.name ?? `User ${suffix}`,
        email: input?.email ?? `${suffix}@lafamila.xyz`,
        password,
        isSuperAdmin: false,
      },
      null,
      { emailVerifiedAt: new Date(), passwordResetRequired: false },
    );
    return { account, password };
  }

  async function createApprovedService(options?: {
    serviceKey?: string;
    name?: string;
    description?: string;
    permissions?: Array<{ key: string; label: string; description?: string }>;
    oidcClients?: Array<{
      clientId: string;
      clientType: 'public' | 'confidential';
      redirectUris: string[];
      allowedScopes?: string[];
      requirePkce?: boolean;
      accessTokenTtlSeconds?: number;
      refreshTokenTtlSeconds?: number;
    }>;
    serviceCredentials?: Array<{
      name: string;
      description?: string;
      scopes: Array<'account.search' | 'permission.read' | 'sync'>;
    }>;
  }): Promise<ApprovedServiceResult> {
    const suffix = nextSuffix('service');
    const serviceKey = options?.serviceKey ?? suffix;
    const requestBody = {
      serviceKey,
      name: options?.name ?? `Service ${suffix}`,
      description: options?.description ?? `Description ${suffix}`,
      requesterName: 'E2E Requester',
      requesterEmail: `requester-${suffix}@lafamila.xyz`,
      permissions: options?.permissions ?? [],
      oidcClients: options?.oidcClients ?? [],
      serviceCredentials: options?.serviceCredentials ?? [],
    };
    const onboarding = app.get(ServiceOnboardingService);
    const createResponse = (await onboarding.create(
      requestBody,
      null,
    )) as unknown as {
      request: { id: string };
    };
    const approvalResponse = await request(app.getHttpServer())
      .post(
        `/api/admin/service-onboarding-requests/${createResponse.request.id}/approve`,
      )
      .set('Cookie', adminCookie)
      .send({})
      .expect(201);
    const service = await dataSource
      .getRepository(ServiceEntity)
      .findOneByOrFail({ serviceKey });
    const permissions = await dataSource
      .getRepository(ServicePermissionDefinitionEntity)
      .find({
        where: { serviceId: service.id },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
    return {
      approval: approvalResponse.body,
      service,
      permissionsByKey: new Map(
        permissions.map((permission) => [permission.key, permission]),
      ),
    };
  }

  function buildAuthorizeQuery(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state?: string;
    prompt?: string;
  }) {
    return {
      response_type: 'code',
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      scope: 'openid profile email service.permission',
      state: input.state ?? 'state',
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      ...(input.prompt ? { prompt: input.prompt } : {}),
    };
  }

  function createPkce(label: string) {
    const verifier = `verifier-${nextSuffix(label)}`;
    return {
      verifier,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
  }

  function getSetCookies(response: {
    headers: Record<string, string | string[] | undefined>;
  }): string[] {
    const value = response.headers['set-cookie'];
    if (!value) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  }

  function getCookiePair(
    response: { headers: Record<string, string | string[] | undefined> },
    name: string,
  ): string {
    const cookie = getSetCookies(response).find((value) =>
      value.startsWith(`${name}=`),
    );
    expect(cookie).toBeDefined();
    return cookie!.split(';')[0];
  }

  function hiddenValue(html: string, name: string): string {
    const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
    expect(match).not.toBeNull();
    return match![1];
  }

  async function exchangeAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    location: string;
  }) {
    const redirect = new URL(input.location);
    expect(redirect.searchParams.get('error')).toBeNull();
    const code = redirect.searchParams.get('code');
    expect(code).toBeTruthy();
    const tokenResponse = await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        code,
        code_verifier: input.codeVerifier,
      })
      .expect(200);
    return app
      .get(TokenService)
      .verifyAccessToken(tokenResponse.body.access_token);
  }

  async function establishHostedSession(input: {
    agent: request.Agent;
    clientId: string;
    redirectUri: string;
    loginId: string;
    password: string;
  }) {
    const pkce = createPkce('hosted-session');
    const authorizeQuery = buildAuthorizeQuery({
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: pkce.challenge,
    });
    const page = await input.agent
      .get('/oauth/authorize')
      .query(authorizeQuery)
      .expect(200);
    const response = await input.agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: hiddenValue(page.text, 'login_transaction'),
        loginId: input.loginId,
        password: input.password,
      })
      .expect(302);
    return {
      payload: await exchangeAuthorizationCode({
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        codeVerifier: pkce.verifier,
        location: response.headers.location,
      }),
      sessionCookie: getCookiePair(response, 'tas_session'),
    };
  }

  async function authorizeAndExchange(
    agent: request.Agent,
    input: {
      clientId: string;
      redirectUri: string;
      expectedServiceKey: string;
      expectedPermission: string;
      loginId?: string;
      password?: string;
    },
  ) {
    const codeVerifier = `verifier-${nextSuffix('pkce')}`;
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const authorizeQuery = buildAuthorizeQuery({
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge,
    });
    const initialAuthorizeResponse = await agent
      .get('/oauth/authorize')
      .query(authorizeQuery)
      .expect((response) => {
        expect([200, 302]).toContain(response.status);
      });
    if (initialAuthorizeResponse.status === 200) {
      expect(input.loginId).toBeTruthy();
      expect(input.password).toBeTruthy();
    }
    const authorizeResponse =
      initialAuthorizeResponse.status === 200
        ? await agent
            .post('/oauth/login')
            .type('form')
            .send({
              login_transaction: hiddenValue(
                initialAuthorizeResponse.text,
                'login_transaction',
              ),
              loginId: input.loginId,
              password: input.password,
            })
            .expect(302)
        : initialAuthorizeResponse;
    const redirect = new URL(authorizeResponse.headers.location);
    expect(redirect.searchParams.get('error')).toBeNull();
    const code = redirect.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenResponse = await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        code,
        code_verifier: codeVerifier,
      })
      .expect(200);

    const payload = app
      .get(TokenService)
      .verifyAccessToken(tokenResponse.body.access_token);
    expect(payload.aud).toBe(`service:${input.expectedServiceKey}`);
    expect(payload['https://lafamila.xyz/claims/service']).toEqual(
      expect.objectContaining({
        key: input.expectedServiceKey,
        permission: input.expectedPermission,
      }),
    );
    return tokenResponse.body as {
      access_token: string;
      refresh_token: string;
    };
  }

  it('boots the full app and serves health', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('serves the hosted login single-submit guard', async () => {
    await request(app.getHttpServer())
      .get('/oauth/hosted-login.js')
      .expect(200)
      .expect('Content-Type', /text\/javascript/)
      .expect('Cache-Control', 'no-store')
      .expect((response) => {
        expect(response.text).toContain("form.addEventListener('submit'");
        expect(response.text).toContain('button.disabled = true');
        expect(response.text).toContain("submitter.textContent = '처리 중'");
      });
  });

  it('renders the hosted login page for authorize requests without tas_session', async () => {
    const clientId = nextSuffix('hosted-login-page-client');
    await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['https://todo.example.com/auth/callback'],
        },
      ],
    });
    const codeChallenge = createHash('sha256')
      .update(`verifier-${nextSuffix('hosted-login-page')}`)
      .digest('base64url');
    const authorizeQuery = buildAuthorizeQuery({
      clientId,
      redirectUri: 'https://todo.example.com/auth/callback',
      codeChallenge,
      state: 'hosted-login-state',
    });
    const expectedReturnTo = `/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'https://todo.example.com/auth/callback',
      response_type: 'code',
      scope: 'openid profile email service.permission',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: 'hosted-login-state',
    }).toString()}`;
    const expectedSignupHref = `/signup?${new URLSearchParams({
      return_to: expectedReturnTo,
    }).toString()}`;

    await request(app.getHttpServer())
      .get('/oauth/authorize')
      .query(authorizeQuery)
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain('action="/oauth/login"');
        expect(response.text).toContain('name="loginId"');
        expect(response.text).toContain('name="password"');
        expect(response.text).toContain(
          '<button type="submit">로그인</button>',
        );
        expect(response.text).toContain('src="/oauth/hosted-login.js"');
        expect(response.headers['content-security-policy']).toContain(
          "script-src 'self'",
        );
        expect(response.headers['content-security-policy']).toContain(
          "form-action 'self' https://todo.example.com",
        );
        expect(response.text).toContain(
          `<a href="${expectedSignupHref}">sign up</a>`,
        );
        expect(response.text).toContain('id="failure-message"');
        expect(response.text).toContain('name="login_transaction"');
        expect(response.text).not.toContain('name="client_id"');
        expect(response.text).not.toContain('name="state"');
        expect(response.text).not.toContain('name="code_challenge"');
        expect(response.text).not.toContain('password/complete-reset');
        expect(response.text).toContain('Teddy Auth');
        expect(response.text).not.toContain('Continue in your browser');
      });
  });

  it('resumes authorize after hosted login and issues tas_session', async () => {
    const clientId = nextSuffix('hosted-login-success-client');
    const approved = await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['https://todo.example.com/auth/callback'],
        },
      ],
    });
    const { account, password } = await createAccount();
    const agent = request.agent(app.getHttpServer());
    const codeVerifier = `verifier-${nextSuffix('hosted-login-success')}`;
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const authorizeQuery = buildAuthorizeQuery({
      clientId,
      redirectUri: 'https://todo.example.com/auth/callback',
      codeChallenge,
      state: 'resume-state',
    });

    const loginPage = await agent
      .get('/oauth/authorize')
      .query(authorizeQuery)
      .expect(200);

    const loginResponse = await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: hiddenValue(loginPage.text, 'login_transaction'),
        loginId: account.loginId,
        password,
      })
      .expect(302);

    const setCookie = loginResponse.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    expect(cookies.join(';')).toContain('tas_session=');
    const redirect = new URL(loginResponse.headers.location);
    expect(redirect.searchParams.get('state')).toBe('resume-state');
    expect(redirect.searchParams.get('error')).toBeNull();
    const code = redirect.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenResponse = await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: 'https://todo.example.com/auth/callback',
        code,
        code_verifier: codeVerifier,
      })
      .expect(200);

    const payload = app
      .get(TokenService)
      .verifyAccessToken(tokenResponse.body.access_token);
    expect(payload.aud).toBe(`service:${approved.service.serviceKey}`);
    expect(payload['https://lafamila.xyz/claims/service']).toEqual(
      expect.objectContaining({
        key: approved.service.serviceKey,
        permission: 'visitor',
      }),
    );
  });

  it('supports browser logout before starting a fresh hosted login flow', async () => {
    const clientId = nextSuffix('hosted-login-logout-client');
    await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['https://todo.example.com/auth/logout-test'],
        },
      ],
    });
    const { account, password } = await createAccount();
    const agent = request.agent(app.getHttpServer());
    const codeChallenge = createHash('sha256')
      .update(`verifier-${nextSuffix('hosted-login-logout')}`)
      .digest('base64url');
    const authorizeQuery = buildAuthorizeQuery({
      clientId,
      redirectUri: 'https://todo.example.com/auth/logout-test',
      codeChallenge,
    });

    const loginPage = await agent
      .get('/oauth/authorize')
      .query(authorizeQuery)
      .expect(200);
    await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: hiddenValue(loginPage.text, 'login_transaction'),
        loginId: account.loginId,
        password,
      })
      .expect(302);

    await agent
      .get('/logout')
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain('로그아웃되었습니다.');
        const setCookie = response.headers['set-cookie'];
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        expect(cookies.join(';')).toContain('tas_session=;');
      });

    await agent
      .get('/oauth/authorize')
      .query(authorizeQuery)
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain('action="/oauth/login"');
        expect(response.text).toContain('name="loginId"');
      });
  });

  it('clears hosted login session and redirects to an allowed return_to URL', async () => {
    const agent = request.agent(app.getHttpServer());

    await agent
      .get('/logout')
      .query({
        return_to:
          'http://localhost:3030/session/oidc/retry?loginTransactionId=retry-1',
      })
      .expect(302)
      .expect((response) => {
        expect(response.headers.location).toBe(
          'http://localhost:3030/session/oidc/retry?loginTransactionId=retry-1',
        );
        const setCookie = response.headers['set-cookie'];
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        expect(cookies.join(';')).toContain('tas_session=;');
      });
  });

  it('selects a request account while preserving the exact P1 tas_session', async () => {
    const clientId = nextSuffix('select-account-client');
    const redirectUri = 'https://todo.example.com/auth/select-account';
    await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: [redirectUri],
        },
      ],
    });
    const p1 = await createAccount({ name: 'Player One' });
    const p2 = await createAccount({ name: 'Player Two' });
    const agent = request.agent(app.getHttpServer());

    const p1Session = await establishHostedSession({
      agent,
      clientId,
      redirectUri,
      loginId: p1.account.loginId,
      password: p1.password,
    });
    expect(p1Session.payload.sub).toBe(p1.account.id);
    expect(p1Session.sessionCookie).toMatch(/^tas_session=/);

    const p2Pkce = createPkce('select-account-p2');
    const p2Query = buildAuthorizeQuery({
      clientId,
      redirectUri,
      codeChallenge: p2Pkce.challenge,
      state: 'player-2-state',
      prompt: 'select_account',
    });
    const selectionPage = await agent
      .get('/oauth/authorize')
      .query(p2Query)
      .expect(200)
      .expect('X-Frame-Options', 'DENY')
      .expect('Cache-Control', 'no-store');
    expect(selectionPage.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
    expect(selectionPage.headers['content-security-policy']).toContain(
      "form-action 'self' https://todo.example.com",
    );
    expect(selectionPage.text).toContain('계정 선택');
    expect(selectionPage.text).toContain('다른 계정 사용');
    expect(selectionPage.text).toContain('src="/oauth/hosted-login.js"');
    expect(selectionPage.text).toContain(p1.account.loginId);
    expect(selectionPage.text).not.toContain('name="prompt"');
    expect(getSetCookies(selectionPage)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^tas_session=/)]),
    );
    const loginTransaction = hiddenValue(
      selectionPage.text,
      'login_transaction',
    );

    await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: loginTransaction,
        account_selection: 'other',
        loginId: p2.account.loginId,
        password: 'wrong-password',
      })
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain('Invalid credentials');
        expect(response.text).not.toContain('property prompt should not exist');
        expect(getSetCookies(response)).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^tas_session=/)]),
        );
      });

    const p2Response = await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: loginTransaction,
        account_selection: 'other',
        loginId: p2.account.loginId,
        password: p2.password,
      })
      .expect(302);
    expect(getSetCookies(p2Response)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^tas_session=/)]),
    );
    const p2Payload = await exchangeAuthorizationCode({
      clientId,
      redirectUri,
      codeVerifier: p2Pkce.verifier,
      location: p2Response.headers.location,
    });
    expect(p2Payload.sub).toBe(p2.account.id);
    expect(p2Payload['https://lafamila.xyz/claims/service']).toEqual(
      expect.objectContaining({ permission: 'visitor' }),
    );

    const normalPkce = createPkce('normal-after-player-2');
    const normalResponse = await agent
      .get('/oauth/authorize')
      .query(
        buildAuthorizeQuery({
          clientId,
          redirectUri,
          codeChallenge: normalPkce.challenge,
          state: 'normal-after-player-2',
        }),
      )
      .expect(302);
    const normalPayload = await exchangeAuthorizationCode({
      clientId,
      redirectUri,
      codeVerifier: normalPkce.verifier,
      location: normalResponse.headers.location,
    });
    expect(normalPayload.sub).toBe(p1.account.id);

    const currentPkce = createPkce('select-current');
    const currentQuery = buildAuthorizeQuery({
      clientId,
      redirectUri,
      codeChallenge: currentPkce.challenge,
      state: 'select-current-state',
      prompt: 'select_account',
    });
    const currentPage = await agent
      .get('/oauth/authorize')
      .query(currentQuery)
      .expect(200);
    const currentResponse = await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: hiddenValue(currentPage.text, 'login_transaction'),
        account_selection: 'current',
      })
      .expect(302);
    expect(getSetCookies(currentResponse)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^tas_session=/)]),
    );
    const currentPayload = await exchangeAuthorizationCode({
      clientId,
      redirectUri,
      codeVerifier: currentPkce.verifier,
      location: currentResponse.headers.location,
    });
    expect(currentPayload.sub).toBe(p1.account.id);
  });

  it('rejects stale prompt values, combinations, and unknown login transactions', async () => {
    const clientId = nextSuffix('prompt-validation-client');
    const redirectUri = 'https://todo.example.com/auth/prompt-validation';
    await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: [redirectUri],
        },
      ],
    });
    const pkce = createPkce('prompt-validation');

    for (const prompt of [
      'login',
      'none',
      'select_account login',
      'select_account select_account',
    ]) {
      const response = await request(app.getHttpServer())
        .get('/oauth/authorize')
        .query(
          buildAuthorizeQuery({
            clientId,
            redirectUri,
            codeChallenge: pkce.challenge,
            prompt,
          }),
        )
        .expect(302);
      const redirect = new URL(response.headers.location);
      expect(redirect.searchParams.get('error')).toBe('invalid_request');
      expect(redirect.searchParams.get('state')).toBe('state');
    }

    await request(app.getHttpServer())
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: 'unknown-transaction',
        account_selection: 'other',
        loginId: 'unknown',
        password: 'unknown',
      })
      .expect(400)
      .expect((response) => {
        expect(response.text).toContain('Invalid or expired login transaction');
        expect(response.text).not.toContain('property prompt should not exist');
      });
  });

  it.each([
    ['client_id', 'tampered-client'],
    ['state', 'tampered-state'],
    ['redirect_uri', 'https://attacker.example.com/callback'],
    ['code_challenge', 'tampered-pkce-challenge'],
    ['scope', 'openid profile'],
  ])(
    'rejects hosted login POST tampering of %s while keeping the transaction usable',
    async (field, value) => {
      const clientId = nextSuffix(`tamper-${field}-client`);
      const redirectUri = `https://todo.example.com/auth/tamper-${field}`;
      await createApprovedService({
        oidcClients: [
          {
            clientId,
            clientType: 'public',
            redirectUris: [redirectUri],
          },
        ],
      });
      const account = await createAccount();
      const agent = request.agent(app.getHttpServer());
      const pkce = createPkce(`tamper-${field}`);
      const authorizeQuery = buildAuthorizeQuery({
        clientId,
        redirectUri,
        codeChallenge: pkce.challenge,
        state: `original-${field}-state`,
      });
      const page = await agent
        .get('/oauth/authorize')
        .query(authorizeQuery)
        .expect(200);
      const transaction = hiddenValue(page.text, 'login_transaction');

      await agent
        .post('/oauth/login')
        .type('form')
        .send({
          login_transaction: transaction,
          loginId: account.account.loginId,
          password: account.password,
          [field]: value,
        })
        .expect(400)
        .expect((response) => {
          expect(JSON.stringify(response.body)).toContain(
            `property ${field} should not exist`,
          );
          expect(response.headers.location).toBeUndefined();
        });

      const cleanResponse = await agent
        .post('/oauth/login')
        .type('form')
        .send({
          login_transaction: transaction,
          loginId: account.account.loginId,
          password: account.password,
        })
        .expect(302);
      expect(
        new URL(cleanResponse.headers.location).searchParams.get('state'),
      ).toBe(`original-${field}-state`);
    },
  );

  it('blocks ordinary hosted login CSRF from a transaction created in another browser', async () => {
    const clientId = nextSuffix('ordinary-login-csrf-client');
    const redirectUri = 'https://todo.example.com/auth/ordinary-login-csrf';
    await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: [redirectUri],
        },
      ],
    });
    const attacker = await createAccount({ name: 'Attacker Account' });
    const p1 = await createAccount({ name: 'Victim P1' });
    const attackerAgent = request.agent(app.getHttpServer());
    const victimAgent = request.agent(app.getHttpServer());
    const csrfPkce = createPkce('ordinary-login-csrf');
    const csrfQuery = buildAuthorizeQuery({
      clientId,
      redirectUri,
      codeChallenge: csrfPkce.challenge,
    });
    const attackerPage = await attackerAgent
      .get('/oauth/authorize')
      .query(csrfQuery)
      .expect(200);
    const attackerTransaction = hiddenValue(
      attackerPage.text,
      'login_transaction',
    );
    const p1Session = await establishHostedSession({
      agent: victimAgent,
      clientId,
      redirectUri,
      loginId: p1.account.loginId,
      password: p1.password,
    });

    await victimAgent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: attackerTransaction,
        loginId: attacker.account.loginId,
        password: attacker.password,
      })
      .expect(400)
      .expect((response) => {
        expect(response.text).toContain('Invalid or expired login transaction');
        expect(getSetCookies(response)).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^tas_session=/)]),
        );
      });

    const normalPkce = createPkce('ordinary-login-csrf-normal');
    const normalResponse = await victimAgent
      .get('/oauth/authorize')
      .query(
        buildAuthorizeQuery({
          clientId,
          redirectUri,
          codeChallenge: normalPkce.challenge,
        }),
      )
      .expect(302);
    const normalPayload = await exchangeAuthorizationCode({
      clientId,
      redirectUri,
      codeVerifier: normalPkce.verifier,
      location: normalResponse.headers.location,
    });
    expect(normalPayload.sub).toBe(p1.account.id);
    expect(p1Session.sessionCookie).toMatch(/^tas_session=/);
  });

  it('supports concurrent selection tabs completed in either order', async () => {
    const clientId = nextSuffix('concurrent-selection-client');
    const redirectUri = 'https://todo.example.com/auth/concurrent-selection';
    await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: [redirectUri],
        },
      ],
    });
    const p1 = await createAccount();
    const p2 = await createAccount();
    const agent = request.agent(app.getHttpServer());
    await establishHostedSession({
      agent,
      clientId,
      redirectUri,
      loginId: p1.account.loginId,
      password: p1.password,
    });
    const firstPkce = createPkce('concurrent-selection-first');
    const secondPkce = createPkce('concurrent-selection-second');
    const firstQuery = buildAuthorizeQuery({
      clientId,
      redirectUri,
      codeChallenge: firstPkce.challenge,
      state: 'first-tab-state',
      prompt: 'select_account',
    });
    const secondQuery = buildAuthorizeQuery({
      clientId,
      redirectUri,
      codeChallenge: secondPkce.challenge,
      state: 'second-tab-state',
      prompt: 'select_account',
    });
    const firstPage = await agent
      .get('/oauth/authorize')
      .query(firstQuery)
      .expect(200);
    const secondPage = await agent
      .get('/oauth/authorize')
      .query(secondQuery)
      .expect(200);
    const firstTransaction = hiddenValue(firstPage.text, 'login_transaction');
    const secondTransaction = hiddenValue(secondPage.text, 'login_transaction');
    expect(firstTransaction).not.toBe(secondTransaction);

    const secondResponse = await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: secondTransaction,
        account_selection: 'other',
        loginId: p2.account.loginId,
        password: p2.password,
      })
      .expect(302);
    const firstResponse = await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: firstTransaction,
        account_selection: 'other',
        loginId: p2.account.loginId,
        password: p2.password,
      })
      .expect(302);

    const secondPayload = await exchangeAuthorizationCode({
      clientId,
      redirectUri,
      codeVerifier: secondPkce.verifier,
      location: secondResponse.headers.location,
    });
    const firstPayload = await exchangeAuthorizationCode({
      clientId,
      redirectUri,
      codeVerifier: firstPkce.verifier,
      location: firstResponse.headers.location,
    });
    expect(secondPayload.sub).toBe(p2.account.id);
    expect(firstPayload.sub).toBe(p2.account.id);
    expect(
      new URL(secondResponse.headers.location).searchParams.get('state'),
    ).toBe('second-tab-state');
    expect(
      new URL(firstResponse.headers.location).searchParams.get('state'),
    ).toBe('first-tab-state');
  });

  it('fails closed when tas_session changes after selection page render', async () => {
    const clientId = nextSuffix('selection-session-change-client');
    const redirectUri = 'https://todo.example.com/auth/session-change';
    await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: [redirectUri],
        },
      ],
    });
    const p1 = await createAccount();
    const replacement = await createAccount();
    const agent = request.agent(app.getHttpServer());
    await establishHostedSession({
      agent,
      clientId,
      redirectUri,
      loginId: p1.account.loginId,
      password: p1.password,
    });
    const selectPkce = createPkce('selection-session-change');
    const selectionPage = await agent
      .get('/oauth/authorize')
      .query(
        buildAuthorizeQuery({
          clientId,
          redirectUri,
          codeChallenge: selectPkce.challenge,
          prompt: 'select_account',
        }),
      )
      .expect(200);
    const oldTransaction = hiddenValue(selectionPage.text, 'login_transaction');

    await agent.get('/logout').expect(200);
    await establishHostedSession({
      agent,
      clientId,
      redirectUri,
      loginId: replacement.account.loginId,
      password: replacement.password,
    });
    await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: oldTransaction,
        account_selection: 'current',
      })
      .expect(400)
      .expect((response) => {
        expect(response.text).toContain(
          'Login session changed during authorization',
        );
      });

    const normalPkce = createPkce('selection-session-change-normal');
    const normalResponse = await agent
      .get('/oauth/authorize')
      .query(
        buildAuthorizeQuery({
          clientId,
          redirectUri,
          codeChallenge: normalPkce.challenge,
        }),
      )
      .expect(302);
    const normalPayload = await exchangeAuthorizationCode({
      clientId,
      redirectUri,
      codeVerifier: normalPkce.verifier,
      location: normalResponse.headers.location,
    });
    expect(normalPayload.sub).toBe(replacement.account.id);
  });

  it('allows exactly one concurrent transaction submission and rejects replay', async () => {
    const clientId = nextSuffix('transaction-replay-client');
    const redirectUri = 'https://todo.example.com/auth/transaction-replay';
    await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: [redirectUri],
        },
      ],
    });
    const account = await createAccount();
    const agent = request.agent(app.getHttpServer());
    const pkce = createPkce('transaction-replay');
    const page = await agent
      .get('/oauth/authorize')
      .query(
        buildAuthorizeQuery({
          clientId,
          redirectUri,
          codeChallenge: pkce.challenge,
        }),
      )
      .expect(200);
    const transaction = hiddenValue(page.text, 'login_transaction');
    const transactionCookie = getSetCookies(page).find((cookie) =>
      cookie.startsWith('tas_authorize_transaction_'),
    );
    expect(transactionCookie).toBeDefined();
    const cookiePair = transactionCookie!.split(';')[0];
    const submission = {
      login_transaction: transaction,
      loginId: account.account.loginId,
      password: account.password,
    };

    const attempts = await Promise.all([
      request(app.getHttpServer())
        .post('/oauth/login')
        .set('Cookie', cookiePair)
        .type('form')
        .send(submission),
      request(app.getHttpServer())
        .post('/oauth/login')
        .set('Cookie', cookiePair)
        .type('form')
        .send(submission),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([
      302, 400,
    ]);
    const success = attempts.find((response) => response.status === 302)!;
    await exchangeAuthorizationCode({
      clientId,
      redirectUri,
      codeVerifier: pkce.verifier,
      location: success.headers.location,
    });

    await request(app.getHttpServer())
      .post('/oauth/login')
      .set('Cookie', cookiePair)
      .type('form')
      .send(submission)
      .expect(400);
  });

  it('rejects an expired hosted login transaction before authentication', async () => {
    const clientId = nextSuffix('expired-login-transaction-client');
    const redirectUri = 'https://todo.example.com/auth/expired-transaction';
    await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: [redirectUri],
        },
      ],
    });
    const account = await createAccount();
    const agent = request.agent(app.getHttpServer());
    const pkce = createPkce('expired-login-transaction');
    const page = await agent
      .get('/oauth/authorize')
      .query(
        buildAuthorizeQuery({
          clientId,
          redirectUri,
          codeChallenge: pkce.challenge,
        }),
      )
      .expect(200);
    const transaction = hiddenValue(page.text, 'login_transaction');
    await dataSource.query(
      `UPDATE token_records
       SET expires_at = now() - interval '1 second'
       WHERE token_hash = $1 AND type = 'authorization_login'`,
      [hashToken(transaction)],
    );

    await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: transaction,
        loginId: account.account.loginId,
        password: account.password,
      })
      .expect(400)
      .expect((response) => {
        expect(response.text).toContain('Invalid or expired login transaction');
        expect(getSetCookies(response)).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^tas_session=/)]),
        );
      });
  });

  it('applies account, client, and service status policy to account selection', async () => {
    const clientId = nextSuffix('select-account-policy-client');
    const redirectUri = 'https://todo.example.com/auth/select-account-policy';
    const approved = await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: [redirectUri],
        },
      ],
    });
    const p1 = await createAccount();
    const disabled = await createAccount();
    const resetRequired = await createAccount();
    const agent = request.agent(app.getHttpServer());
    await establishHostedSession({
      agent,
      clientId,
      redirectUri,
      loginId: p1.account.loginId,
      password: p1.password,
    });
    await dataSource
      .getRepository(AccountEntity)
      .update({ id: disabled.account.id }, { status: 'disabled' });
    await dataSource
      .getRepository(AccountEntity)
      .update(
        { id: resetRequired.account.id },
        { passwordResetRequired: true },
      );

    const submitOtherAccount = async (input: {
      loginId: string;
      password: string;
      expectedMessage: string;
    }) => {
      const pkce = createPkce('select-account-policy');
      const query = buildAuthorizeQuery({
        clientId,
        redirectUri,
        codeChallenge: pkce.challenge,
        prompt: 'select_account',
      });
      const page = await agent.get('/oauth/authorize').query(query).expect(200);
      await agent
        .post('/oauth/login')
        .type('form')
        .send({
          login_transaction: hiddenValue(page.text, 'login_transaction'),
          account_selection: 'other',
          loginId: input.loginId,
          password: input.password,
        })
        .expect(200)
        .expect((response) => {
          expect(response.text).toContain(input.expectedMessage);
          expect(getSetCookies(response)).not.toEqual(
            expect.arrayContaining([expect.stringMatching(/^tas_session=/)]),
          );
        });
    };

    await submitOtherAccount({
      loginId: disabled.account.loginId,
      password: disabled.password,
      expectedMessage: 'Invalid credentials',
    });
    await submitOtherAccount({
      loginId: resetRequired.account.loginId,
      password: resetRequired.password,
      expectedMessage: 'Password reset is required',
    });

    const statusPkce = createPkce('select-account-status');
    const statusQuery = buildAuthorizeQuery({
      clientId,
      redirectUri,
      codeChallenge: statusPkce.challenge,
      prompt: 'select_account',
    });
    await dataSource
      .getRepository(OidcClientEntity)
      .update({ clientId }, { status: 'disabled' });
    await agent.get('/oauth/authorize').query(statusQuery).expect(400).expect({
      error: 'unauthorized_client',
      error_description: 'Client is disabled',
    });

    await dataSource
      .getRepository(OidcClientEntity)
      .update({ clientId }, { status: 'active' });
    await dataSource
      .getRepository(ServiceEntity)
      .update({ id: approved.service.id }, { status: 'disabled' });
    await agent.get('/oauth/authorize').query(statusQuery).expect(400).expect({
      error: 'unauthorized_client',
      error_description: 'Client is disabled',
    });
  });

  it('shows a failure message on hosted login credential errors', async () => {
    const clientId = nextSuffix('hosted-login-failure-client');
    await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['https://todo.example.com/auth/failure'],
        },
      ],
    });
    const { account } = await createAccount();
    const agent = request.agent(app.getHttpServer());
    const codeChallenge = createHash('sha256')
      .update(`verifier-${nextSuffix('hosted-login-failure')}`)
      .digest('base64url');
    const authorizeQuery = buildAuthorizeQuery({
      clientId,
      redirectUri: 'https://todo.example.com/auth/failure',
      codeChallenge,
    });

    const loginPage = await agent
      .get('/oauth/authorize')
      .query(authorizeQuery)
      .expect(200);

    await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: hiddenValue(loginPage.text, 'login_transaction'),
        loginId: account.loginId,
        password: 'wrong-password',
      })
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain('Invalid credentials');
        expect(response.text).toContain('id="failure-message"');
        expect(response.headers.location).toBeUndefined();
      });
  });

  it('does not expose public JSON POST /login anymore', async () => {
    await request(app.getHttpServer())
      .post('/login')
      .send({
        loginId: 'anyone',
        password: 'irrelevant',
      })
      .expect(404);
  });

  it('completes bootstrap with the same admin session cookie and response shape as login', async () => {
    expect(adminCookie.join(';')).toContain('tas_admin_session');
    expect(bootstrapCompleteBody).toEqual(
      expect.objectContaining({
        account: expect.objectContaining({
          loginId: expect.stringContaining('superadmin-e2e'),
          isSuperAdmin: true,
        }),
        idleExpiresAt: expect.any(String),
        absoluteExpiresAt: expect.any(String),
      }),
    );

    await request(app.getHttpServer())
      .get('/api/admin/session')
      .set('Cookie', adminCookie)
      .expect(200)
      .expect((response) => {
        expect(response.body.account).toEqual(
          expect.objectContaining({
            loginId: expect.stringContaining('superadmin-e2e'),
            isSuperAdmin: true,
          }),
        );
      });
  });

  it('serves the cleaned admin UI surface', async () => {
    const adminHtml = readFileSync(
      join(process.cwd(), 'public', 'index.html'),
      'utf8',
    );
    expect(adminHtml).toContain('Service Onboarding Requests');
    expect(adminHtml).toContain('Account Access Requests');
    expect(adminHtml).not.toContain('Create Service Onboarding Request');
    expect(adminHtml).not.toContain('JSON Preview');
    expect(adminHtml).not.toContain('Request-update-only secret');
    expect(adminHtml).toContain('One-Time Operational Secrets');
    expect(adminHtml).toContain('Copy Value');
    expect(adminHtml).toContain('confirmSecretModal');
    expect(adminHtml).toContain('copySecretEnvExamples');
    expect(adminHtml).toContain('Confirm');
    expect(adminHtml).toContain('secretStorageConfirmed');
    expect(adminHtml).toContain('secret 을 별도로 보관했습니다');
    expect(adminHtml).toContain('credentialScopeModal');
    expect(adminHtml).toContain('data-credential-scope');
    expect(adminHtml).not.toContain('CREDENTIAL_SCOPE_OPTIONS');
    expect(adminHtml).toContain('Concrete .env examples');
    expect(adminHtml).toContain('Service Approved Without Secrets');
    expect(adminHtml).toContain(
      'No .env secret values are required from this approval result.',
    );
    expect(adminHtml).toContain('[hidden]');
    expect(adminHtml).toContain('display: none !important;');
    expect(adminHtml).toContain(
      "mode === 'bootstrap' && state.requiresBootstrap",
    );
    expect(adminHtml).toContain(
      'Bootstrap is unavailable because an active superadmin already exists.',
    );
    expect(adminHtml).toContain(
      "state.adminSession ? 'Logout' : 'Admin Session'",
    );
    expect(adminHtml).not.toContain('adminSessionForm');
    expect(adminHtml).not.toContain('adminLogout');
    expect(adminHtml).not.toContain(
      "$('secretModal').addEventListener('click'",
    );
    expect(adminHtml.indexOf('Service Onboarding Requests')).toBeLessThan(
      adminHtml.indexOf('Account Access Requests'),
    );
    expect(adminHtml.indexOf('Account Access Requests')).toBeLessThan(
      adminHtml.indexOf('Accounts'),
    );
    expect(adminHtml).not.toContain('Admin Surface');
    expect(adminHtml).not.toContain('Latest Onboarding Secrets');
    expect(adminHtml).not.toContain('Latest Credential Secret');
    expect(adminHtml).not.toContain('Create Account');
    expect(adminHtml).not.toContain('Create Service Credential');
    expect(adminHtml).not.toContain('Create OIDC Client');
    expect(adminHtml).not.toContain('Assign Service Permission');

    await request(app.getHttpServer())
      .get('/admin')
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain('Service Onboarding Requests');
        expect(response.text).not.toContain(
          'Create Service Onboarding Request',
        );
      });
  });

  it('serves the service request builder on /service', async () => {
    const serviceHtml = readFileSync(
      join(process.cwd(), 'public', 'service.html'),
      'utf8',
    );
    expect(serviceHtml).toContain('Create Service Onboarding Request');
    expect(serviceHtml).toContain('Import Request JSON');
    expect(serviceHtml).toContain('Drop a service request JSON file here');
    expect(serviceHtml).toContain('serviceRequestImportInput');
    expect(serviceHtml).toContain('serviceRequestImportText');
    expect(serviceHtml).toContain('Import Pasted JSON');
    expect(serviceHtml).toContain('importPastedServiceRequest');
    expect(serviceHtml).toContain(
      "await importServiceRequestText(await file.text(), file.name, 'file')",
    );
    expect(serviceHtml).toContain("'pasted JSON',");
    expect(serviceHtml).toContain("'paste',");
    expect(serviceHtml).toContain('Paste request JSON before importing.');
    expect(serviceHtml).toContain('serviceRequestImportMessage');
    expect(serviceHtml).toContain('service-request-import.js');
    expect(serviceHtml).toContain('/api/service-credential-scopes');
    expect(serviceHtml).toContain('data-credential-scope');
    expect(serviceHtml).toContain('JSON Preview');
    expect(serviceHtml).toContain('Request-update-only secret');
    expect(serviceHtml).toContain('Admin Session required');
    expect(serviceHtml).toContain(
      'Unknown JSON fields are ignored and reported as warnings.',
    );
    expect(serviceHtml).toContain('visitor permission is');
    expect(serviceHtml).toContain('readonly');
    expect(serviceHtml).toContain('Requester');
    expect(serviceHtml).toContain(
      'identity always comes from the current admin session.',
    );
    expect(serviceHtml).toContain(
      "mode === 'bootstrap' && state.requiresBootstrap",
    );
    expect(serviceHtml).toContain(
      'Bootstrap is unavailable because an active superadmin already exists.',
    );
    expect(serviceHtml).toContain(
      "$('openAdminAccess').textContent = state.adminSession",
    );
    expect(serviceHtml).toContain("? 'Logout'");
    expect(serviceHtml).toContain(": 'Admin Session'");
    expect(serviceHtml).not.toContain('adminSessionForm');
    expect(serviceHtml).not.toContain('adminLogout');

    await request(app.getHttpServer())
      .get('/service')
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain('Create Service Onboarding Request');
        expect(response.text).toContain('Import Request JSON');
        expect(response.text).toContain('JSON Preview');
      });

    await request(app.getHttpServer())
      .get('/service-request-import.js')
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain('normalizeImportedServiceRequest');
        expect(response.text).toContain('Ignored unknown top-level fields');
        expect(response.text).toContain('Removed visitor permission');
        expect(response.text).not.toContain('SUPPORTED_CREDENTIAL_SCOPES');
      });

    await request(app.getHttpServer())
      .get('/api/service-credential-scopes')
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ key: 'account.search' }),
            expect.objectContaining({ key: 'permission.read' }),
          ]),
        );
      });
  });

  it('creates and revises a pending service onboarding request with its request secret', async () => {
    const suffix = nextSuffix('pending-update');
    const serviceKey = suffix;
    const requestIp = `2001:db8::${Date.now().toString(16)}`;
    const createResponse = await request(app.getHttpServer())
      .post('/api/service-onboarding-requests')
      .set('x-forwarded-for', requestIp)
      .send({
        serviceKey,
        name: `Pending ${suffix}`,
        requesterName: 'E2E Requester',
        requesterEmail: `requester-${suffix}@lafamila.xyz`,
        permissions: [{ key: 'member', label: 'Member' }],
        oidcClients: [
          {
            clientId: `${suffix}-client`,
            clientType: 'public',
            redirectUris: [`https://example.com/${suffix}/callback`],
            allowedScopes: ['openid', 'profile', 'email', 'service.permission'],
            requirePkce: true,
          },
        ],
        serviceCredentials: [
          {
            name: `${suffix} backend`,
            scopes: ['account.search'],
          },
        ],
      })
      .expect(201);

    expect(createResponse.body.request).toEqual(
      expect.objectContaining({
        serviceKey,
        kind: 'create',
        status: 'pending',
        revision: 1,
      }),
    );
    expect(createResponse.body.requestSecret).toBeTruthy();

    const updateResponse = await request(app.getHttpServer())
      .post(
        `/api/service-onboarding-requests/${createResponse.body.request.id}/update`,
      )
      .set('x-forwarded-for', requestIp)
      .set('x-request-secret', createResponse.body.requestSecret)
      .send({
        serviceKey,
        name: `Pending ${suffix} revised`,
        requesterName: 'E2E Requester',
        requesterEmail: `requester-${suffix}@lafamila.xyz`,
        permissions: [
          { key: 'member', label: 'Member' },
          { key: 'admin', label: 'Admin' },
        ],
        oidcClients: [
          {
            clientId: `${suffix}-client`,
            clientType: 'public',
            redirectUris: [`https://example.com/${suffix}/callback`],
            allowedScopes: ['openid', 'profile', 'email', 'service.permission'],
            requirePkce: true,
          },
        ],
        serviceCredentials: [
          {
            name: `${suffix} backend`,
            scopes: ['account.search', 'permission.read'],
          },
        ],
      })
      .expect(201);

    expect(updateResponse.body.request).toEqual(
      expect.objectContaining({
        serviceKey,
        kind: 'update',
        status: 'pending',
        revision: 2,
      }),
    );
    expect(updateResponse.body.request.requestedSpec.permissions).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'admin' })]),
    );

    const requests = await dataSource
      .getRepository(ServiceOnboardingRequestEntity)
      .find({
        where: { serviceKey },
        order: { revision: 'ASC' },
      });
    expect(requests).toHaveLength(2);
    expect(requests[0].status).toBe('superseded');
    expect(requests[1].status).toBe('pending');

    await request(app.getHttpServer())
      .get('/api/admin/service-onboarding-requests?status=pending')
      .set('Cookie', adminCookie)
      .expect(200)
      .expect((response) => {
        const body = response.body as Array<{
          id: string;
          serviceKey: string;
          revision: number;
        }>;
        const matches = body.filter((item) => item.serviceKey === serviceKey);
        expect(matches).toHaveLength(1);
        expect(matches[0]).toEqual(
          expect.objectContaining({
            id: updateResponse.body.request.id,
            revision: 2,
          }),
        );
      });
  });

  it('removes unsupported admin write endpoints while keeping allowed operational routes', async () => {
    const approved = await createApprovedService({
      permissions: [{ key: 'admin', label: 'Admin' }],
      oidcClients: [
        {
          clientId: nextSuffix('removed-routes-client'),
          clientType: 'confidential',
          redirectUris: ['http://127.0.0.1/removed-routes/callback'],
        },
      ],
      serviceCredentials: [
        {
          name: 'removed-routes credential',
          scopes: ['account.search'],
        },
      ],
    });
    const { account } = await createAccount();
    const serviceId = approved.service.id;
    const visitorId = approved.permissionsByKey.get('visitor')?.id;
    const clientId = await dataSource
      .getRepository(OidcClientEntity)
      .findOneByOrFail({
        serviceId,
      });
    await request(app.getHttpServer())
      .get('/api/admin/accounts')
      .set('Cookie', adminCookie)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/admin/services')
      .set('Cookie', adminCookie)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/admin/services/${serviceId}/permissions`)
      .set('Cookie', adminCookie)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/admin/services/${serviceId}/clients`)
      .set('Cookie', adminCookie)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/admin/services/${serviceId}/credentials`)
      .set('Cookie', adminCookie)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/admin/service-credential-scopes')
      .set('Cookie', adminCookie)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ key: 'account.search' }),
            expect.objectContaining({ key: 'permission.read' }),
          ]),
        );
      });

    await request(app.getHttpServer())
      .post('/api/admin/accounts')
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/admin/services/${serviceId}`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceId}/permissions`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/admin/services/${serviceId}/permissions/${visitorId}`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(
        `/api/admin/services/${serviceId}/permissions/${visitorId}/deprecate`,
      )
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceId}/permissions/${visitorId}/migrate`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceId}/permissions/${visitorId}/remove`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceId}/clients`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/admin/services/${serviceId}/clients/${clientId.id}`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(
        `/api/admin/services/${serviceId}/clients/${clientId.id}/rotate-secret`,
      )
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceId}/credentials`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .put(`/api/admin/accounts/${account.id}/services/${serviceId}/permission`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .delete(
        `/api/admin/accounts/${account.id}/services/${serviceId}/permission`,
      )
      .set('Cookie', adminCookie)
      .expect(404);
  });

  it('keeps service credential update, rotate, and disable operations after onboarding approval', async () => {
    const approved = await createApprovedService({
      serviceCredentials: [
        {
          name: 'todo-api local',
          description: 'account search integration',
          scopes: ['account.search'],
        },
      ],
    });
    const serviceCredentialSecret = approved.approval.secrets.find(
      (secret) => secret.kind === 'service_credential',
    );
    expect(serviceCredentialSecret).toBeTruthy();
    expect(serviceCredentialSecret?.secret).toBeTruthy();

    const credential = await dataSource
      .getRepository(ServiceCredentialEntity)
      .findOneByOrFail({ serviceId: approved.service.id });

    await request(app.getHttpServer())
      .get(`/api/admin/services/${approved.service.id}/credentials`)
      .set('Cookie', adminCookie)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: credential.id,
              keyId: credential.keyId,
              scopes: ['account.search'],
              status: 'active',
            }),
          ]),
        );
        expect(response.body[0].secret).toBeUndefined();
        expect(response.body[0].secretHash).toBeUndefined();
      });

    await request(app.getHttpServer())
      .patch(
        `/api/admin/services/${approved.service.id}/credentials/${credential.id}`,
      )
      .set('Cookie', adminCookie)
      .send({
        name: 'todo-api local updated',
        scopes: ['account.search', 'permission.read'],
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.objectContaining({
            id: credential.id,
            name: 'todo-api local updated',
            scopes: ['account.search', 'permission.read'],
            status: 'active',
          }),
        );
        expect(response.body.secret).toBeUndefined();
        expect(response.body.secretHash).toBeUndefined();
      });

    const rotateResponse = await request(app.getHttpServer())
      .post(
        `/api/admin/services/${approved.service.id}/credentials/${credential.id}/rotate`,
      )
      .set('Cookie', adminCookie)
      .send({})
      .expect(201);
    expect(rotateResponse.body.secret).toBeTruthy();

    await request(app.getHttpServer())
      .post(
        `/api/admin/services/${approved.service.id}/credentials/${credential.id}/disable`,
      )
      .set('Cookie', adminCookie)
      .send({})
      .expect(201)
      .expect((response) => {
        expect(response.body.status).toBe('disabled');
      });

    await request(app.getHttpServer())
      .post(
        `/api/admin/services/${approved.service.id}/credentials/${credential.id}/rotate`,
      )
      .set('Cookie', adminCookie)
      .send({})
      .expect(400)
      .expect((response) => {
        expect(response.body.message).toBe(
          'Disabled credentials cannot be rotated',
        );
      });
  });

  it('lazily grants visitor to a newly created account on first service login and supports access request approval', async () => {
    const clientId = nextSuffix('lazy-existing-service-client');
    const approved = await createApprovedService({
      permissions: [
        { key: 'admin', label: 'Admin', description: 'Elevated access' },
        { key: 'premium', label: 'Premium', description: 'Paid access' },
      ],
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['bodylab://auth/callback'],
        },
      ],
    });
    const { account, password } = await createAccount();
    expect(
      await dataSource.getRepository(AccountServicePermissionEntity).findOneBy({
        accountId: account.id,
        serviceId: approved.service.id,
      }),
    ).toBeNull();

    const agent = request.agent(app.getHttpServer());
    const visitorTokens = await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'bodylab://auth/callback',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
      loginId: account.loginId,
      password,
    });

    const visitorAssignment = await dataSource
      .getRepository(AccountServicePermissionEntity)
      .findOneOrFail({
        where: { accountId: account.id, serviceId: approved.service.id },
        relations: { permissionDefinition: true },
      });
    expect(visitorAssignment.permissionDefinition.key).toBe('visitor');

    await request(app.getHttpServer())
      .post('/api/service-applications')
      .set('authorization', `Bearer ${visitorTokens.access_token}`)
      .send({
        serviceKey: approved.service.serviceKey,
        requestedPermissionKey: 'missing',
        message: 'I need access for testing.',
      })
      .expect(400);

    const applicationResponse = await request(app.getHttpServer())
      .post('/api/service-applications')
      .set('authorization', `Bearer ${visitorTokens.access_token}`)
      .send({
        serviceKey: approved.service.serviceKey,
        requestedPermissionKey: 'admin',
        message: 'I need access for testing.',
      })
      .expect(201);
    expect(applicationResponse.body.targetPermissionDefinitionId).toBe(
      approved.permissionsByKey.get('admin')?.id,
    );

    await request(app.getHttpServer())
      .post(
        `/api/admin/service-applications/${applicationResponse.body.id}/approve`,
      )
      .set('Cookie', adminCookie)
      .send({
        targetPermissionDefinitionId:
          approved.permissionsByKey.get('premium')?.id,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post(
        `/api/admin/service-applications/${applicationResponse.body.id}/approve`,
      )
      .set('Cookie', adminCookie)
      .send({
        targetPermissionDefinitionId:
          approved.permissionsByKey.get('admin')?.id,
      })
      .expect(201);

    await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'bodylab://auth/callback',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'admin',
    });
  });

  it('allows only strictly higher service-defined permission applications', async () => {
    const clientId = nextSuffix('permission-upgrade-client');
    const approved = await createApprovedService({
      permissions: [
        { key: 'user', label: 'User' },
        { key: 'admin', label: 'Admin' },
      ],
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['travel://auth/callback'],
        },
      ],
    });
    const { account, password } = await createAccount();
    const agent = request.agent(app.getHttpServer());
    const visitorTokens = await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'travel://auth/callback',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
      loginId: account.loginId,
      password,
    });

    const userApplication = await request(app.getHttpServer())
      .post('/api/service-applications')
      .set('authorization', `Bearer ${visitorTokens.access_token}`)
      .send({
        serviceKey: approved.service.serviceKey,
        requestedPermissionKey: 'user',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/api/admin/service-applications/${userApplication.body.id}/approve`,
      )
      .set('Cookie', adminCookie)
      .send({
        targetPermissionDefinitionId: approved.permissionsByKey.get('user')?.id,
      })
      .expect(201);

    const userTokens = await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'travel://auth/callback',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'user',
    });
    const applyAsUser = (requestedPermissionKey?: string, message?: string) =>
      request(app.getHttpServer())
        .post('/api/service-applications')
        .set('authorization', `Bearer ${userTokens.access_token}`)
        .send({
          serviceKey: approved.service.serviceKey,
          ...(requestedPermissionKey ? { requestedPermissionKey } : {}),
          ...(message ? { message } : {}),
        });

    await applyAsUser().expect(400);
    await applyAsUser('user').expect(400);
    await applyAsUser('visitor').expect(400);
    await applyAsUser('superadmin').expect(400);
    await applyAsUser('missing').expect(400);
    await request(app.getHttpServer())
      .post('/api/service-applications')
      .set('authorization', `Bearer ${userTokens.access_token}`)
      .send({
        serviceKey: nextSuffix('other-service'),
        requestedPermissionKey: 'admin',
      })
      .expect(403);

    const adminPermission = approved.permissionsByKey.get('admin');
    expect(adminPermission).toBeDefined();
    await dataSource
      .getRepository(ServicePermissionDefinitionEntity)
      .update({ id: adminPermission!.id }, { status: 'deprecated' });
    await applyAsUser('admin').expect(400);
    await dataSource
      .getRepository(ServicePermissionDefinitionEntity)
      .update({ id: adminPermission!.id }, { status: 'active' });

    const adminApplication = await applyAsUser('admin', 'First request').expect(
      201,
    );
    const updatedApplication = await applyAsUser(
      'admin',
      'Updated request',
    ).expect(201);
    expect(updatedApplication.body.id).toBe(adminApplication.body.id);
    expect(updatedApplication.body.message).toBe('Updated request');
    expect(updatedApplication.body.targetPermissionDefinitionId).toBe(
      adminPermission!.id,
    );

    await expect(
      app
        .get(ServiceApplicationsService)
        .statusForServiceAccount(approved.service.serviceKey, account.id),
    ).resolves.toEqual(expect.objectContaining({ status: 'pending' }));

    await request(app.getHttpServer())
      .post(
        `/api/admin/service-applications/${adminApplication.body.id}/approve`,
      )
      .set('Cookie', adminCookie)
      .send({ targetPermissionDefinitionId: adminPermission!.id })
      .expect(201);
  });

  it('lazily grants visitor to an existing account after a new service is approved', async () => {
    const { account, password } = await createAccount();
    const clientId = nextSuffix('lazy-new-service-client');
    const approved = await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['bodylab-mac://auth/callback'],
        },
      ],
    });
    expect(
      await dataSource.getRepository(AccountServicePermissionEntity).findOneBy({
        accountId: account.id,
        serviceId: approved.service.id,
      }),
    ).toBeNull();

    const agent = request.agent(app.getHttpServer());
    await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'bodylab-mac://auth/callback',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
      loginId: account.loginId,
      password,
    });

    const assignment = await dataSource
      .getRepository(AccountServicePermissionEntity)
      .findOneOrFail({
        where: { accountId: account.id, serviceId: approved.service.id },
        relations: { permissionDefinition: true },
      });
    expect(assignment.permissionDefinition.key).toBe('visitor');
  });

  it('lazily grants superadmin permission to a super admin on first service login', async () => {
    const suffix = nextSuffix('lazy-superadmin');
    const password = 'Superadmin-service-password-1234!';
    const account = await app.get(AccountsService).create({
      loginId: suffix,
      name: 'Lazy Service Super Admin',
      email: `${suffix}@lafamila.xyz`,
      password,
      isSuperAdmin: true,
    });
    const clientId = nextSuffix('lazy-superadmin-client');
    const approved = await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['bodylab-mac://auth/callback'],
        },
      ],
    });
    expect(
      await dataSource.getRepository(AccountServicePermissionEntity).findOneBy({
        accountId: account.id,
        serviceId: approved.service.id,
      }),
    ).toBeNull();

    const agent = request.agent(app.getHttpServer());
    await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'bodylab-mac://auth/callback',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'superadmin',
      loginId: account.loginId,
      password,
    });

    const assignment = await dataSource
      .getRepository(AccountServicePermissionEntity)
      .findOneOrFail({
        where: { accountId: account.id, serviceId: approved.service.id },
        relations: { permissionDefinition: true },
      });
    expect(assignment.permissionDefinition.key).toBe('superadmin');
  });

  it('does not auto-restore a revoked assignment during lazy visitor lookup', async () => {
    const clientId = nextSuffix('revoked-client');
    const approved = await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['revoked://auth/callback'],
        },
      ],
    });
    const { account, password } = await createAccount();
    const agent = request.agent(app.getHttpServer());

    await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'revoked://auth/callback',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
      loginId: account.loginId,
      password,
    });

    const assignmentRepository = dataSource.getRepository(
      AccountServicePermissionEntity,
    );
    const assignment = await assignmentRepository.findOneByOrFail({
      accountId: account.id,
      serviceId: approved.service.id,
    });
    assignment.status = 'revoked';
    assignment.revokedAt = new Date();
    await assignmentRepository.save(assignment);

    const codeVerifier = `verifier-${nextSuffix('revoked')}`;
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const authorizeResponse = await agent
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'revoked://auth/callback',
        scope: 'openid profile email service.permission',
        state: 'revoked-state',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      })
      .expect(302);
    const redirect = new URL(authorizeResponse.headers.location);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('error_description')).toBe(
      'No service permission',
    );

    const persisted = await assignmentRepository.findOneByOrFail({
      id: assignment.id,
    });
    expect(persisted.status).toBe('revoked');
  });

  it('protects internal account search with scoped service credentials', async () => {
    const todoApproved = await createApprovedService({
      serviceCredentials: [
        {
          name: 'search credential',
          scopes: ['account.search'],
        },
        {
          name: 'wrong scope credential',
          scopes: ['permission.read'],
        },
      ],
    });
    const otherApproved = await createApprovedService();
    const { account } = await createAccount();

    const searchSecret = todoApproved.approval.secrets.find(
      (secret) =>
        secret.kind === 'service_credential' &&
        secret.name === 'search credential',
    );
    const wrongScopeSecret = todoApproved.approval.secrets.find(
      (secret) =>
        secret.kind === 'service_credential' &&
        secret.name === 'wrong scope credential',
    );
    expect(searchSecret).toBeTruthy();
    expect(wrongScopeSecret).toBeTruthy();

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .query({
        serviceKey: todoApproved.service.serviceKey,
        q: account.loginId.slice(0, 4),
      })
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchSecret?.keyId as string)
      .set('x-auth-service-secret', 'wrong-secret')
      .query({
        serviceKey: todoApproved.service.serviceKey,
        q: account.loginId.slice(0, 4),
      })
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', wrongScopeSecret?.keyId as string)
      .set('x-auth-service-secret', wrongScopeSecret?.secret as string)
      .query({
        serviceKey: todoApproved.service.serviceKey,
        q: account.loginId.slice(0, 4),
      })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchSecret?.keyId as string)
      .set('x-auth-service-secret', searchSecret?.secret as string)
      .query({
        serviceKey: otherApproved.service.serviceKey,
        q: account.loginId.slice(0, 4),
      })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchSecret?.keyId as string)
      .set('x-auth-service-secret', searchSecret?.secret as string)
      .query({
        serviceKey: todoApproved.service.serviceKey,
        q: account.loginId.slice(0, 4),
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: account.id,
              loginId: account.loginId,
              email: account.email,
              permissionKey: 'visitor',
            }),
          ]),
        );
      });

    const searchCredential = await dataSource
      .getRepository(ServiceCredentialEntity)
      .findOneByOrFail({ keyId: searchSecret?.keyId as string });
    expect(searchCredential.lastUsedAt).not.toBeNull();
    expect(searchCredential.lastUsedFrom).toBeTruthy();

    await request(app.getHttpServer())
      .post(
        `/api/admin/services/${todoApproved.service.id}/credentials/${searchCredential.id}/disable`,
      )
      .set('Cookie', adminCookie)
      .send({})
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchSecret?.keyId as string)
      .set('x-auth-service-secret', searchSecret?.secret as string)
      .query({
        serviceKey: todoApproved.service.serviceKey,
        q: account.loginId.slice(0, 4),
      })
      .expect(401);
  });

  it('verifies a presented service credential for the caller own service', async () => {
    const todoApproved = await createApprovedService({
      serviceCredentials: [
        { name: 'sync caller credential', scopes: ['sync'] },
        { name: 'laptop sync credential', scopes: ['sync'] },
        { name: 'no sync credential', scopes: ['account.search'] },
      ],
    });
    const otherApproved = await createApprovedService({
      serviceCredentials: [{ name: 'other service sync', scopes: ['sync'] }],
    });

    const secretByName = (approved: ApprovedServiceResult, name: string) => {
      const secret = approved.approval.secrets.find(
        (candidate) =>
          candidate.kind === 'service_credential' && candidate.name === name,
      ) as { keyId: string; secret: string } | undefined;
      expect(secret).toBeTruthy();
      return secret as { keyId: string; secret: string };
    };
    const caller = secretByName(todoApproved, 'sync caller credential');
    const laptop = secretByName(todoApproved, 'laptop sync credential');
    const noSync = secretByName(todoApproved, 'no sync credential');
    const foreign = secretByName(otherApproved, 'other service sync');

    const verifyAs = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/api/internal/service-credentials/verify')
        .set('x-auth-service-key-id', caller.keyId)
        .set('x-auth-service-secret', caller.secret)
        .send(body);

    await request(app.getHttpServer())
      .get('/api/service-credential-scopes')
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.arrayContaining([expect.objectContaining({ key: 'sync' })]),
        );
      });

    await request(app.getHttpServer())
      .post('/api/internal/service-credentials/verify')
      .send({
        keyId: laptop.keyId,
        secret: laptop.secret,
        requiredScope: 'sync',
      })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/internal/service-credentials/verify')
      .set('x-auth-service-key-id', caller.keyId)
      .set('x-auth-service-secret', 'wrong-caller-secret')
      .send({
        keyId: laptop.keyId,
        secret: laptop.secret,
        requiredScope: 'sync',
      })
      .expect(401);

    await verifyAs({
      keyId: laptop.keyId,
      secret: laptop.secret,
      requiredScope: 'sync',
    })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          valid: true,
          serviceKey: todoApproved.service.serviceKey,
          scopes: ['sync'],
          status: 'active',
        });
      });

    await verifyAs({
      keyId: laptop.keyId,
      secret: 'wrong-target-secret',
      requiredScope: 'sync',
    })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          valid: false,
          reason: 'invalid_credential',
        });
      });

    await verifyAs({
      keyId: noSync.keyId,
      secret: noSync.secret,
      requiredScope: 'sync',
    })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          valid: false,
          reason: 'scope_missing',
        });
      });

    await verifyAs({ keyId: noSync.keyId, secret: noSync.secret })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          valid: true,
          serviceKey: todoApproved.service.serviceKey,
          scopes: ['account.search'],
          status: 'active',
        });
      });

    await verifyAs({
      keyId: foreign.keyId,
      secret: foreign.secret,
      requiredScope: 'sync',
    })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          valid: false,
          reason: 'invalid_credential',
        });
      });

    await verifyAs({
      keyId: laptop.keyId,
      secret: laptop.secret,
      requiredScope: 'not.a.scope',
    }).expect(400);

    const laptopCredential = await dataSource
      .getRepository(ServiceCredentialEntity)
      .findOneByOrFail({ keyId: laptop.keyId });
    expect(laptopCredential.lastUsedAt).not.toBeNull();

    await request(app.getHttpServer())
      .post(
        `/api/admin/services/${todoApproved.service.id}/credentials/${laptopCredential.id}/disable`,
      )
      .set('Cookie', adminCookie)
      .send({})
      .expect(201);

    await verifyAs({
      keyId: laptop.keyId,
      secret: laptop.secret,
      requiredScope: 'sync',
    })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({ valid: false, reason: 'disabled' });
      });
  });

  it('issues access tokens honoring a per-client TTL override', async () => {
    const clientId = nextSuffix('ttl-override-client');
    const approved = await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['https://todo.example.com/ttl-override'],
          accessTokenTtlSeconds: 1800,
        },
      ],
    });
    const { account, password } = await createAccount();
    const agent = request.agent(app.getHttpServer());
    const tokens = await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'https://todo.example.com/ttl-override',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
      loginId: account.loginId,
      password,
    });

    const payload = app
      .get(TokenService)
      .verifyAccessToken(tokens.access_token) as { iat: number; exp: number };
    expect(payload.exp - payload.iat).toBe(1800);

    const storedClient = await dataSource
      .getRepository(OidcClientEntity)
      .findOneByOrFail({ clientId });
    expect(storedClient.accessTokenTtlSeconds).toBe(1800);
    expect(storedClient.refreshTokenTtlSeconds).toBeNull();
  });

  it('denies refresh and revokes the family after the account is disabled', async () => {
    const clientId = nextSuffix('disable-refresh-client');
    const approved = await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['https://todo.example.com/disable-refresh'],
        },
      ],
    });
    const { account, password } = await createAccount();
    const agent = request.agent(app.getHttpServer());
    const tokens = await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'https://todo.example.com/disable-refresh',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
      loginId: account.loginId,
      password,
    });

    const rotated = await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      })
      .expect(200);

    await app.get(AccountsService).update(account.id, { status: 'disabled' });

    await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: rotated.body.refresh_token,
      })
      .expect(403)
      .expect((response) => {
        expect(response.body.error).toBe('access_denied');
      });

    const remaining = await dataSource.query(
      `SELECT count(*)::int AS c FROM token_records WHERE account_id = $1 AND type = 'refresh_token' AND status IN ('active', 'used')`,
      [account.id],
    );
    expect(remaining[0].c).toBe(0);
  });

  it('revokes refresh families when an account password is reset', async () => {
    const clientId = nextSuffix('reset-refresh-client');
    const approved = await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['https://todo.example.com/reset-refresh'],
        },
      ],
    });
    const { account, password } = await createAccount();
    const agent = request.agent(app.getHttpServer());
    const tokens = await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'https://todo.example.com/reset-refresh',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
      loginId: account.loginId,
      password,
    });

    await app
      .get(AccountsService)
      .resetPassword(account.id, 'New-password-1234!');

    // The account is still active, but its refresh family was revoked.
    await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      })
      .expect(401);
  });

  it('allows a duplicate refresh within the grace window over HTTP', async () => {
    const clientId = nextSuffix('grace-within-client');
    const approved = await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['https://todo.example.com/grace-within'],
        },
      ],
    });
    const { account, password } = await createAccount();
    const agent = request.agent(app.getHttpServer());
    const tokens = await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'https://todo.example.com/grace-within',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
      loginId: account.loginId,
      password,
    });

    const firstRotation = await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      })
      .expect(200);
    expect(firstRotation.body.refresh_token).toBeTruthy();

    // Re-present the original refresh token inside the default 60s grace window.
    const graceRotation = await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      })
      .expect(200);
    expect(graceRotation.body.refresh_token).toBeTruthy();

    // The successor from the first rotation still works (family not revoked).
    await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: firstRotation.body.refresh_token,
      })
      .expect(200);
  });

  it('revokes the family when a refresh token is replayed beyond the grace window', async () => {
    const clientId = nextSuffix('grace-beyond-client');
    const approved = await createApprovedService({
      oidcClients: [
        {
          clientId,
          clientType: 'public',
          redirectUris: ['https://todo.example.com/grace-beyond'],
        },
      ],
    });
    const { account, password } = await createAccount();
    const agent = request.agent(app.getHttpServer());
    const tokens = await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'https://todo.example.com/grace-beyond',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
      loginId: account.loginId,
      password,
    });

    const rotation = await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      })
      .expect(200);

    // Age the consumed token past the grace window, then replay it.
    await dataSource.query(
      `UPDATE token_records SET used_at = now() - interval '10 minutes' WHERE token_hash = $1 AND type = 'refresh_token'`,
      [hashToken(tokens.refresh_token)],
    );

    await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      })
      .expect(401);

    // The family is revoked, so the successor is rejected too.
    await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: rotation.body.refresh_token,
      })
      .expect(401);
  });
});
