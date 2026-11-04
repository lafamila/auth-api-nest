import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AccountEntity } from '../src/database/entities/account.entity';
import { OidcClientEntity } from '../src/database/entities/oidc-client.entity';
import { ServiceEntity } from '../src/database/entities/service.entity';
import { ServicePermissionDefinitionEntity } from '../src/database/entities/service-permission-definition.entity';
import { SocialIdentityEntity } from '../src/database/entities/social-identity.entity';
import { SocialLoginTransactionEntity } from '../src/database/entities/social-login-transaction.entity';
import { EmailVerificationEntity } from '../src/database/entities/email-verification.entity';
import { AccountsService } from '../src/domain/accounts/accounts.service';
import { TokenService } from '../src/oidc/token.service';
import { EmailDeliveryService } from '../src/signup/email-delivery.service';
import { SocialIdentityProfile } from '../src/social/social-provider.types';
import { SocialProvidersService } from '../src/social/social-providers.service';
import { hashToken } from '../src/common/crypto/token-hash';

const describeIsolated = process.env.TEST_DATABASE_URL
  ? describe
  : describe.skip;

describeIsolated('Social login (isolated e2e)', () => {
  let app: INestApplication;
  let db: DataSource;
  let service: ServiceEntity;
  let clientId: string;
  let exchange: jest.SpyInstance;
  let mail: jest.SpyInstance;
  const profiles = new Map<string, SocialIdentityProfile>();
  const callback = 'https://service.example.test/oidc/callback';
  const verifier = 'p'.repeat(48);
  const providerClientId = (provider: string) => `test-${provider}-client`;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    if (
      !process.env.TEST_DATABASE_URL ||
      !/(?:test|e2e|scratch)/i.test(
        new URL(process.env.TEST_DATABASE_URL).pathname,
      )
    ) {
      throw new Error(
        'TEST_DATABASE_URL must explicitly target an isolated test/e2e/scratch database',
      );
    }
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.RUN_MIGRATIONS = 'false';
    process.env.NOTIFICATIONS_ENABLED = 'false';
    process.env.PERMISSION_WEBHOOKS_ENABLED = 'false';
    process.env.ISSUER_URL = 'http://localhost:3032';
    process.env.COOKIE_SECRET = 'social-e2e-cookie-secret';
    for (const provider of ['google', 'kakao', 'naver']) {
      process.env[`SOCIAL_${provider.toUpperCase()}_CLIENT_ID`] =
        providerClientId(provider);
      process.env[`SOCIAL_${provider.toUpperCase()}_CLIENT_SECRET`] =
        'test-only-secret';
    }
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.use(cookieParser(process.env.COOKIE_SECRET));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
    db = app.get(DataSource);
    service = await db.getRepository(ServiceEntity).save({
      serviceKey: `social-e2e-${randomUUID()}`,
      name: 'Social E2E',
      status: 'active',
    });
    await db.getRepository(ServicePermissionDefinitionEntity).save({
      serviceId: service.id,
      key: 'visitor',
      label: 'Visitor',
      status: 'active',
    });
    clientId = `social-e2e-${randomUUID()}`;
    await db.getRepository(OidcClientEntity).save({
      serviceId: service.id,
      clientId,
      clientType: 'public',
      redirectUris: [callback, 'social-test:/oauth/callback'],
      allowedGrantTypes: ['authorization_code', 'refresh_token'],
      allowedScopes: ['openid', 'profile', 'email', 'service.permission'],
      requirePkce: true,
      status: 'active',
    });
    exchange = jest.spyOn(app.get(SocialProvidersService), 'exchangeCode');
    mail = jest
      .spyOn(app.get(EmailDeliveryService), 'sendSignupCode')
      .mockResolvedValue(undefined);
  });

  beforeEach(() => {
    profiles.clear();
    for (const provider of ['google', 'kakao', 'naver']) {
      profiles.set(provider, {
        provider,
        providerClientId: providerClientId(provider),
        subject: randomUUID(),
        email: `${randomUUID()}@gmail.com`,
        emailVerified: provider !== 'naver',
        name: 'Social User',
      });
    }
    exchange
      .mockReset()
      .mockImplementation(async (provider: string) => profiles.get(provider)!);
    mail.mockClear();
  });

  afterAll(async () => {
    await app?.close();
    for (const key of Object.keys(process.env))
      if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  function target(response: request.Response): string {
    if (response.status === 302) return response.headers.location;
    const match = response.text.match(
      /id="authorization-redirect" href="([^"]+)"/,
    );
    expect(match).not.toBeNull();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    return match![1].replaceAll('&amp;', '&');
  }

  function cookies(response: request.Response): string {
    const value: unknown = response.headers['set-cookie'];
    return Array.isArray(value)
      ? value
          .filter((part): part is string => typeof part === 'string')
          .join(';')
      : typeof value === 'string'
        ? value
        : '';
  }

  async function begin(
    provider = 'google',
    agent = request.agent(app.getHttpServer()),
    prompt?: string,
    redirectUri = callback,
  ) {
    const page = await agent
      .get('/oauth/authorize')
      .query({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid profile email service.permission',
        state: 'original-client-state',
        nonce: 'original-client-nonce',
        code_challenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        code_challenge_method: 'S256',
        ...(prompt ? { prompt } : {}),
      })
      .expect(200);
    const transaction = page.text.match(
      /name="login_transaction" value="([^"]+)"/,
    )![1];
    const start = await agent
      .post(`/oauth/login/social/${provider}`)
      .type('form')
      .send({ login_transaction: transaction })
      .expect(200);
    const url = new URL(target(start));
    const state = url.searchParams.get('state')!;
    expect(url.searchParams.get('redirect_uri')).toBe(
      `http://localhost:3032/oauth/social/${provider}/callback`,
    );
    expect(cookies(start)).toContain('SameSite=Lax');
    return { agent, state, transaction, url, redirectUri };
  }

  async function providerCallback(
    login: Awaited<ReturnType<typeof begin>>,
    provider = 'google',
    expectedStatus = 302,
  ) {
    return login.agent
      .get(`/oauth/social/${provider}/callback`)
      .query({ state: login.state, code: 'provider-authorization-code' })
      .expect(expectedStatus);
  }

  async function complete(
    login: Awaited<ReturnType<typeof begin>>,
    provider = 'google',
    extra: Record<string, string> = {},
    status = 200,
  ) {
    return login.agent
      .post('/oauth/social/complete')
      .type('form')
      .send({
        transaction: login.state,
        email: profiles.get(provider)!.email,
        name: 'Social User',
        ...extra,
      })
      .expect(status);
  }

  async function tokens(response: request.Response, redirectUri = callback) {
    const url = new URL(target(response));
    expect(url.searchParams.get('state')).toBe('original-client-state');
    const result = await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code: url.searchParams.get('code'),
        code_verifier: verifier,
      })
      .expect(200);
    const claims = app
      .get(TokenService)
      .verifyAccessToken(result.body.access_token);
    const idClaims = app
      .get(TokenService)
      .verifyAccessToken(result.body.id_token);
    expect(idClaims.nonce).toBe('original-client-nonce');
    const account = await db
      .getRepository(AccountEntity)
      .findOneByOrFail({ id: claims.sub as string });
    expect(claims['https://lafamila.xyz/claims/local_login_id']).toBe(
      account.loginId,
    );
    expect(idClaims['https://lafamila.xyz/claims/local_login_id']).toBe(
      account.loginId,
    );
    const userinfo = await request(app.getHttpServer())
      .get('/oidc/userinfo')
      .set('Authorization', `Bearer ${result.body.access_token}`)
      .expect(200);
    expect(userinfo.body['https://lafamila.xyz/claims/local_login_id']).toBe(
      account.loginId,
    );
    return claims;
  }

  async function localAccount(
    email: string,
    status: AccountEntity['status'] = 'active',
  ) {
    const account = await app.get(AccountsService).create(
      {
        loginId: `local-${randomUUID()}`,
        name: 'Existing User',
        email,
        password: 'Existing-password!',
        isSuperAdmin: false,
      },
      null,
      { emailVerifiedAt: new Date() },
    );
    if (status !== 'active')
      await db.getRepository(AccountEntity).update(account.id, { status });
    return account;
  }

  it('creates a genuinely social-only account and preserves downstream OIDC fields', async () => {
    const login = await begin();
    await providerCallback(login);
    const page = await login.agent
      .get('/oauth/social/signup')
      .query({ transaction: login.state })
      .expect(200);
    expect(page.text).toContain('name="loginId"');
    const response = await complete(login);
    const claims = await tokens(response);
    const account = await db
      .getRepository(AccountEntity)
      .findOneByOrFail({ id: claims.sub as string });
    expect(account.loginId).toBeNull();
    expect(account.passwordHash).toBeNull();
    expect(account.emailVerifiedAt).not.toBeNull();
    expect(account.isSuperAdmin).toBe(false);
    expect(claims.preferred_username).toBe(account.email);
    await expect(
      app.get(AccountsService).resetPassword(account.id),
    ).rejects.toThrow('local');
    await login.agent
      .post('/oauth/social/complete')
      .type('form')
      .send({
        transaction: login.state,
        email: account.email,
        name: account.name,
      })
      .expect(400);
  });

  it('allows checked optional local ID with a matching password pair', async () => {
    const loginId = `social-local-${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/api/signup/check-login-id')
      .send({ loginId })
      .expect(201)
      .expect(({ body }) => expect(body.available).toBe(true));
    const login = await begin();
    await providerCallback(login);
    const response = await complete(login, 'google', {
      loginId,
      password: 'Optional-password!',
      passwordConfirm: 'Optional-password!',
    });
    const claims = await tokens(response);
    const account = await app
      .get(AccountsService)
      .authenticate(loginId, 'Optional-password!');
    expect(account.id).toBe(claims.sub);
    expect(claims.preferred_username).toBe(loginId);
  });

  it('requires a matching password for an optional ID and retains the signup for retry', async () => {
    const login = await begin();
    await providerCallback(login);
    await complete(login, 'google', { loginId: 'without-password' }, 400);
    await complete(
      login,
      'google',
      {
        loginId: 'mismatch',
        password: 'Long-password!',
        passwordConfirm: 'Other-password!',
      },
      400,
    );
    await complete(login);
  });

  it('rechecks ID uniqueness even after the availability check succeeded', async () => {
    const login = await begin();
    await providerCallback(login);
    const existing = await localAccount(`${randomUUID()}@example.test`);
    await complete(
      login,
      'google',
      {
        loginId: existing.loginId!,
        password: 'New-password!',
        passwordConfirm: 'New-password!',
      },
      409,
    );
    await complete(login);
    await expect(
      app
        .get(AccountsService)
        .authenticate(existing.loginId!, 'Existing-password!'),
    ).resolves.toMatchObject({ id: existing.id });
  });

  it('links Google, Kakao and email-proven Naver to the same existing account', async () => {
    const email = `${randomUUID()}@gmail.com`;
    const existing = await localAccount(email);
    for (const provider of ['google', 'kakao', 'naver'])
      profiles.get(provider)!.email = email;
    for (const provider of ['google', 'kakao']) {
      const login = await begin(provider);
      const response = await providerCallback(login, provider, 200);
      expect((await tokens(response)).sub).toBe(existing.id);
    }
    const naver = await begin('naver');
    await providerCallback(naver, 'naver');
    await naver.agent
      .post('/oauth/social/email/start')
      .send({ transaction: naver.state, email })
      .expect(200);
    const code = mail.mock.calls[0][1] as string;
    await naver.agent
      .post('/oauth/social/email/verify')
      .send({ transaction: naver.state, code })
      .expect(200);
    const response = await complete(naver, 'naver');
    expect((await tokens(response)).sub).toBe(existing.id);
    expect(
      await db
        .getRepository(SocialIdentityEntity)
        .countBy({ accountId: existing.id }),
    ).toBe(3);
    expect(await db.getRepository(AccountEntity).countBy({ email })).toBe(1);
  });

  it('does not move an existing identity to another account when provider email changes', async () => {
    const initial = await begin();
    await providerCallback(initial);
    const first = await tokens(await complete(initial));
    const other = await localAccount(`${randomUUID()}@gmail.com`);
    profiles.get('google')!.email = other.email;
    const next = await begin();
    const result = await providerCallback(next, 'google', 200);
    expect((await tokens(result)).sub).toBe(first.sub);
  });

  it('does not require email to be shared again for an already linked identity', async () => {
    const initial = await begin();
    await providerCallback(initial);
    const first = await tokens(await complete(initial));
    profiles.get('google')!.email = null;
    profiles.get('google')!.emailVerified = false;
    const next = await begin();
    expect(
      (await tokens(await providerCallback(next, 'google', 200))).sub,
    ).toBe(first.sub);
  });

  it.each(['locked', 'disabled'] as const)(
    'does not link a %s account',
    async (status) => {
      const existing = await localAccount(
        profiles.get('google')!.email!,
        status,
      );
      const login = await begin();
      await providerCallback(login, 'google', 401);
      expect(
        await db
          .getRepository(SocialIdentityEntity)
          .countBy({ accountId: existing.id }),
      ).toBe(0);
    },
  );

  it('blocks unverified email auto-linking and forged emailVerified input', async () => {
    profiles.get('google')!.emailVerified = false;
    const existing = await localAccount(profiles.get('google')!.email!);
    const login = await begin();
    await providerCallback(login);
    await complete(login, 'google', {}, 401);
    await login.agent
      .post('/oauth/social/complete')
      .send({
        transaction: login.state,
        email: existing.email,
        name: 'Forged',
        emailVerified: true,
      })
      .expect(400);
    expect(
      await db
        .getRepository(SocialIdentityEntity)
        .countBy({ accountId: existing.id }),
    ).toBe(0);
  });

  it('verifies a missing provider email and keeps OTP attempts after failures', async () => {
    profiles.get('naver')!.email = null;
    const login = await begin('naver');
    await providerCallback(login, 'naver');
    const email = `${randomUUID()}@example.test`;
    await login.agent
      .post('/oauth/social/email/start')
      .send({ transaction: login.state, email })
      .expect(200);
    const code = mail.mock.calls[0][1] as string;
    const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    await login.agent
      .post('/oauth/social/email/verify')
      .send({ transaction: login.state, code: wrong })
      .expect(401);
    const transaction = await db
      .getRepository(SocialLoginTransactionEntity)
      .findOneByOrFail({ tokenHash: hashToken(login.state) });
    const verification = await db
      .getRepository(EmailVerificationEntity)
      .findOneByOrFail({ id: transaction.data.emailVerificationId });
    expect(verification.attemptCount).toBe(1);
    expect(verification.purpose).toBe('social');
    await login.agent
      .post('/oauth/social/email/verify')
      .send({ transaction: login.state, code })
      .expect(200);
    const response = await complete(login, 'naver', { email });
    expect((await tokens(response)).email).toBe(email);
  });

  it('rejects expired OTP and limits attempts and resends', async () => {
    const login = await begin('naver');
    await providerCallback(login, 'naver');
    const email = profiles.get('naver')!.email!;
    await login.agent
      .post('/oauth/social/email/start')
      .send({ transaction: login.state, email })
      .expect(200);
    const code = mail.mock.calls[0][1] as string;
    await login.agent
      .post('/oauth/social/email/start')
      .send({ transaction: login.state, email })
      .expect(400);
    const transaction = await db
      .getRepository(SocialLoginTransactionEntity)
      .findOneByOrFail({ tokenHash: hashToken(login.state) });
    const repository = db.getRepository(EmailVerificationEntity);
    const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    for (let attempt = 0; attempt < 5; attempt++)
      await login.agent
        .post('/oauth/social/email/verify')
        .send({ transaction: login.state, code: wrong })
        .expect(401);
    await login.agent
      .post('/oauth/social/email/verify')
      .send({ transaction: login.state, code })
      .expect(401);
    await repository.update(transaction.data.emailVerificationId!, {
      attemptCount: 0,
      expiresAt: new Date(Date.now() - 1),
    });
    await login.agent
      .post('/oauth/social/email/verify')
      .send({ transaction: login.state, code })
      .expect(401);
  });

  it('rejects missing browser binding, changed provider, expired state and replay', async () => {
    const login = await begin();
    await request(app.getHttpServer())
      .get('/oauth/social/google/callback')
      .query({ state: login.state, code: 'provider-code' })
      .expect(400);
    expect(exchange).not.toHaveBeenCalled();
    await login.agent
      .get('/oauth/social/naver/callback')
      .query({ state: login.state, code: 'provider-code' })
      .expect(400);
    expect(exchange).not.toHaveBeenCalled();
    await providerCallback(login);
    await providerCallback(login, 'google', 400);
    const expired = await begin();
    await db
      .getRepository(SocialLoginTransactionEntity)
      .update(
        { tokenHash: hashToken(expired.state) },
        { expiresAt: new Date(Date.now() - 1) },
      );
    await providerCallback(expired, 'google', 400);
  });

  it('exchanges a provider code once under concurrent callback delivery', async () => {
    const login = await begin();
    const results = await Promise.all(
      [0, 1].map(() =>
        login.agent
          .get('/oauth/social/google/callback')
          .query({ state: login.state, code: 'provider-code' }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([302, 400]);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('creates a signup once under concurrent completion', async () => {
    const login = await begin();
    await providerCallback(login);
    const results = await Promise.all(
      [0, 1].map(() =>
        login.agent
          .post('/oauth/social/complete')
          .type('form')
          .send({
            transaction: login.state,
            email: profiles.get('google')!.email,
            name: 'Concurrent',
          }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(
      await db
        .getRepository(AccountEntity)
        .countBy({ email: profiles.get('google')!.email! }),
    ).toBe(1);
  });

  it('serializes simultaneous new identities sharing the same email', async () => {
    profiles.get('kakao')!.email = profiles.get('google')!.email;
    const google = await begin('google');
    const kakao = await begin('kakao');
    await providerCallback(google);
    await providerCallback(kakao, 'kakao');
    const results = await Promise.all([
      complete(google),
      complete(kakao, 'kakao'),
    ]);
    const subjects = await Promise.all(
      results.map((response) => tokens(response)),
    );
    expect(subjects[0].sub).toBe(subjects[1].sub);
  });

  it('keeps native service callback redirects and original nonce/PKCE', async () => {
    const login = await begin(
      'google',
      undefined,
      undefined,
      'social-test:/oauth/callback',
    );
    await providerCallback(login);
    const result = await complete(login, 'google', {}, 302);
    expect((await tokens(result, login.redirectUri)).sub).toBeTruthy();
  });

  it('preserves the central SSO account when selecting another account socially', async () => {
    const first = await begin();
    await providerCallback(first);
    const firstClaims = await tokens(await complete(first));
    const selected = await localAccount(profiles.get('kakao')!.email!);
    const selection = await begin('kakao', first.agent, 'select_account');
    const response = await providerCallback(selection, 'kakao', 200);
    expect(cookies(response)).not.toContain('tas_session=');
    expect((await tokens(response)).sub).toBe(selected.id);
    const normal = await first.agent
      .get('/oauth/authorize')
      .query({
        client_id: clientId,
        redirect_uri: callback,
        response_type: 'code',
        scope: 'openid profile email service.permission',
        state: 'original-client-state',
        nonce: 'original-client-nonce',
        code_challenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        code_challenge_method: 'S256',
      })
      .expect(302);
    expect((await tokens(normal)).sub).toBe(firstClaims.sub);
  });

  it('stores only encrypted PKCE material and exchanges the matching verifier', async () => {
    const login = await begin();
    const row = await db
      .getRepository(SocialLoginTransactionEntity)
      .findOneByOrFail({ tokenHash: hashToken(login.state) });
    expect(row.tokenHash).not.toBe(login.state);
    expect(row.data.encryptedVerifier).toMatch(/^v1\./);
    await providerCallback(login);
    const exchangedVerifier = exchange.mock.calls[0][1].codeVerifier as string;
    expect(row.data.encryptedVerifier).not.toContain(exchangedVerifier);
    expect(
      createHash('sha256').update(exchangedVerifier).digest('base64url'),
    ).toBe(login.url.searchParams.get('code_challenge'));
  });

  it('rejects corrupted PKCE ciphertext and provider/client mismatches', async () => {
    const corrupt = await begin();
    const repository = db.getRepository(SocialLoginTransactionEntity);
    const row = await repository.findOneByOrFail({
      tokenHash: hashToken(corrupt.state),
    });
    row.data.encryptedVerifier = 'invalid-ciphertext';
    await repository.save(row);
    await providerCallback(corrupt, 'google', 400);
    expect(exchange).not.toHaveBeenCalled();
    const rotated = await begin();
    process.env.SOCIAL_GOOGLE_CLIENT_ID = 'rotated-client';
    try {
      await providerCallback(rotated, 'google', 400);
      expect(exchange).not.toHaveBeenCalled();
    } finally {
      process.env.SOCIAL_GOOGLE_CLIENT_ID = providerClientId('google');
    }
    const mismatch = await begin();
    exchange.mockResolvedValueOnce({
      ...profiles.get('google')!,
      providerClientId: 'another-client',
    });
    await providerCallback(mismatch, 'google', 401);
  });

  it.each(['disable', 'replace-client'] as const)(
    'rejects provider %s while signup and OTP are pending',
    async (operation) => {
      const login = await begin('naver');
      await providerCallback(login, 'naver');
      const variable =
        operation === 'disable'
          ? 'SOCIAL_NAVER_CLIENT_SECRET'
          : 'SOCIAL_NAVER_CLIENT_ID';
      const prior = process.env[variable];
      process.env[variable] = operation === 'disable' ? '' : 'replaced-client';
      try {
        await login.agent
          .get('/oauth/social/signup')
          .query({ transaction: login.state })
          .expect(400);
        await login.agent
          .post('/oauth/social/email/start')
          .send({
            transaction: login.state,
            email: profiles.get('naver')!.email,
          })
          .expect(400);
        await login.agent
          .post('/oauth/social/email/verify')
          .send({ transaction: login.state, code: 'AAAAAA' })
          .expect(400);
        await complete(login, 'naver', {}, 400);
        expect(mail).not.toHaveBeenCalled();
      } finally {
        process.env[variable] = prior;
      }
    },
  );

  it('allows secret-only rotation after callback and rejects proof after signup expiry', async () => {
    const login = await begin();
    await providerCallback(login);
    const prior = process.env.SOCIAL_GOOGLE_CLIENT_SECRET;
    process.env.SOCIAL_GOOGLE_CLIENT_SECRET = 'rotated-secret';
    try {
      await complete(login);
    } finally {
      process.env.SOCIAL_GOOGLE_CLIENT_SECRET = prior;
    }
    const expired = await begin('naver');
    await providerCallback(expired, 'naver');
    const row = await db
      .getRepository(SocialLoginTransactionEntity)
      .findOneByOrFail({ tokenHash: hashToken(expired.state) });
    row.data.emailVerified = true;
    row.expiresAt = new Date(Date.now() - 1);
    await db.getRepository(SocialLoginTransactionEntity).save(row);
    await complete(expired, 'naver', {}, 400);
  });

  it('rejects completion before the provider callback authenticates a profile', async () => {
    const login = await begin();
    await complete(login, 'google', {}, 400);
    expect(exchange).not.toHaveBeenCalled();
  });

  async function changeCentralSession(agent: request.Agent) {
    const account = await localAccount(`${randomUUID()}@example.test`);
    const page = await agent
      .get('/oauth/authorize')
      .query({
        client_id: clientId,
        redirect_uri: callback,
        response_type: 'code',
        scope: 'openid',
        code_challenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        code_challenge_method: 'S256',
      })
      .expect(200);
    await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: page.text.match(
          /name="login_transaction" value="([^"]+)"/,
        )![1],
        loginId: account.loginId,
        password: 'Existing-password!',
      })
      .expect(200);
  }

  it('rejects an SSO change before callback and before signup/OTP operations', async () => {
    const callbackLogin = await begin();
    await changeCentralSession(callbackLogin.agent);
    await providerCallback(callbackLogin, 'google', 400);
    expect(exchange).not.toHaveBeenCalled();
    const signupLogin = await begin('naver');
    await providerCallback(signupLogin, 'naver');
    await changeCentralSession(signupLogin.agent);
    await signupLogin.agent
      .post('/oauth/social/email/start')
      .send({
        transaction: signupLogin.state,
        email: profiles.get('naver')!.email,
      })
      .expect(400);
    await signupLogin.agent
      .post('/oauth/social/email/verify')
      .send({ transaction: signupLogin.state, code: 'AAAAAA' })
      .expect(400);
    await complete(signupLogin, 'naver', {}, 400);
  });

  it('isolates social email proof from ordinary signup and other transactions', async () => {
    const login = await begin('naver');
    await providerCallback(login, 'naver');
    const email = profiles.get('naver')!.email!;
    await login.agent
      .post('/oauth/social/email/start')
      .send({ transaction: login.state, email })
      .expect(200);
    const code = mail.mock.calls[0][1] as string;
    await request(app.getHttpServer())
      .post('/api/signup/verify-code')
      .send({ email, code })
      .expect(401);
    const row = await db
      .getRepository(SocialLoginTransactionEntity)
      .findOneByOrFail({ tokenHash: hashToken(login.state) });
    const verifications = db.getRepository(EmailVerificationEntity);
    await verifications.update(row.data.emailVerificationId!, {
      contextHash: hashToken('another-transaction'),
    });
    await login.agent
      .post('/oauth/social/email/verify')
      .send({ transaction: login.state, code })
      .expect(401);
    await verifications.update(row.data.emailVerificationId!, {
      contextHash: row.tokenHash,
    });
    await login.agent
      .post('/oauth/social/email/verify')
      .send({ transaction: login.state, code })
      .expect(200);
    await complete(
      login,
      'naver',
      { email: `${randomUUID()}@example.test` },
      401,
    );
  });

  it.each([
    ['first link', false, 'disabled'],
    ['linked login', true, 'disabled'],
    ['first link', false, 'locked'],
    ['linked login', true, 'locked'],
    ['first link', false, 'reset'],
    ['linked login', true, 'reset'],
  ] as const)(
    'does not overwrite an admin %s mutation during %s (%s)',
    async (_label, linked, mutation) => {
      const existing = await localAccount(profiles.get('google')!.email!);
      if (linked)
        await db.getRepository(SocialIdentityEntity).save({
          accountId: existing.id,
          provider: 'google',
          providerClientId: providerClientId('google'),
          subject: profiles.get('google')!.subject,
        });
      const login = await begin();
      const admin = db.createQueryRunner();
      await admin.connect();
      await admin.startTransaction();
      try {
        await admin.manager.update(
          AccountEntity,
          existing.id,
          mutation === 'reset'
            ? {
                passwordHash: 'new-admin-password-hash',
                passwordResetRequired: true,
              }
            : { status: mutation },
        );
        const pending = login.agent
          .get('/oauth/social/google/callback')
          .query({ state: login.state, code: 'provider-code' })
          .then((result) => result);
        let blocked = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const rows: Array<{ waiting: boolean }> = await db.query(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%accounts%') AS waiting",
          );
          if (rows[0]?.waiting) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await admin.commitTransaction();
        const response = await pending;
        expect(blocked).toBe(true);
        expect(response.status).toBe(401);
        const persisted = await db
          .getRepository(AccountEntity)
          .findOneByOrFail({ id: existing.id });
        expect(persisted.status).toBe(
          mutation === 'reset' ? 'active' : mutation,
        );
        expect(persisted.passwordHash).toBe(
          mutation === 'reset'
            ? 'new-admin-password-hash'
            : existing.passwordHash,
        );
        expect(persisted.passwordResetRequired).toBe(mutation === 'reset');
      } finally {
        if (admin.isTransactionActive) await admin.rollbackTransaction();
        await admin.release();
      }
    },
  );
});
