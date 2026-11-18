import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AesGcmService } from '../src/common/crypto/aes-gcm.service';
import { hashToken } from '../src/common/crypto/token-hash';
import { TotpService } from '../src/common/crypto/totp.service';
import { AccountServicePermissionEntity } from '../src/database/entities/account-service-permission.entity';
import { AccountEntity } from '../src/database/entities/account.entity';
import { AdminMfaEntity } from '../src/database/entities/admin-mfa.entity';
import { EmailVerificationEntity } from '../src/database/entities/email-verification.entity';
import { ServicePermissionDefinitionEntity } from '../src/database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../src/database/entities/service.entity';
import { SocialIdentityEntity } from '../src/database/entities/social-identity.entity';
import { TokenRecordEntity } from '../src/database/entities/token-record.entity';
import { AccountsService } from '../src/domain/accounts/accounts.service';
import { EmailDeliveryService } from '../src/signup/email-delivery.service';
import { SocialIdentityProfile } from '../src/social/social-provider.types';
import { SocialProvidersService } from '../src/social/social-providers.service';

const PORTAL_DATABASE_NAME = 'auth_portal_e2e';
const ISSUER = 'http://localhost:3032';
const COOKIE_SECRET = 'portal-e2e-cookie-secret';
const GOOGLE_CLIENT_ID = 'portal-e2e-google-client';
const GOOGLE_CLIENT_SECRET = 'portal-e2e-google-secret';
const KAKAO_CLIENT_ID = 'portal-e2e-kakao-client';
const KAKAO_CLIENT_SECRET = 'portal-e2e-kakao-secret';
const describeIsolated = process.env.TEST_DATABASE_URL
  ? describe
  : describe.skip;

jest.setTimeout(30_000);

interface LocalAccountFixture {
  account: AccountEntity;
  loginId: string;
  password: string;
}

interface PortalAgent {
  get(path: string): request.Test;
  post(path: string): request.Test;
}

describeIsolated('Auth portal (isolated e2e)', () => {
  let app: INestApplication;
  let db: DataSource;
  let accounts: AccountsService;
  let local: LocalAccountFixture;
  let admin: LocalAccountFixture;
  let adminOtpSecret: string;
  let exchangeCode: jest.SpiedFunction<SocialProvidersService['exchangeCode']>;
  const deliveredEmailCodes = new Map<string, string>();
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      throw new Error('TEST_DATABASE_URL must use PostgreSQL');
    }
    const hasDatabaseOverride = [...parsed.searchParams.keys()].some((key) =>
      ['database', 'dbname'].includes(key.toLowerCase()),
    );
    const databaseName = decodeURIComponent(
      parsed.pathname.replace(/^\/+/, ''),
    );
    if (
      hasDatabaseOverride ||
      !/^auth_portal_e2e(?:_[a-z0-9_]+)?$/.test(databaseName)
    ) {
      throw new Error(
        `Portal e2e requires the dedicated ${PORTAL_DATABASE_NAME} database without database query overrides`,
      );
    }

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = databaseUrl;
    process.env.RUN_MIGRATIONS = 'false';
    process.env.NOTIFICATIONS_ENABLED = 'false';
    process.env.PERMISSION_WEBHOOKS_ENABLED = 'false';
    process.env.ISSUER_URL = ISSUER;
    process.env.COOKIE_SECRET = COOKIE_SECRET;
    process.env.SOCIAL_GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
    process.env.SOCIAL_GOOGLE_CLIENT_SECRET = GOOGLE_CLIENT_SECRET;
    process.env.SOCIAL_KAKAO_CLIENT_ID = KAKAO_CLIENT_ID;
    process.env.SOCIAL_KAKAO_CLIENT_SECRET = KAKAO_CLIENT_SECRET;
    process.env.SOCIAL_NAVER_CLIENT_ID = '';
    process.env.SOCIAL_NAVER_CLIENT_SECRET = '';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser(COOKIE_SECRET));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
    db = app.get(DataSource);
    // Keep earlier suites/reruns from consuming this isolated fixture's IP quota.
    await db.getRepository(EmailVerificationEntity).clear();
    accounts = app.get(AccountsService);
    exchangeCode = jest.spyOn(SocialProvidersService.prototype, 'exchangeCode');
    jest
      .spyOn(app.get(EmailDeliveryService), 'sendSignupCode')
      .mockImplementation(async (email, code) => {
        deliveredEmailCodes.set(email, code);
      });

    local = await createLocalAccount('portal-user', false);
    admin = await createLocalAccount('portal-admin', true);
    adminOtpSecret = await configureAdminOtp(admin.account);
    await seedPortalServices(local.account);
  });

  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('redirects unauthenticated roots to the shared login and serves local profile data', async () => {
    await request(app.getHttpServer())
      .get('/')
      .expect(302)
      .expect('Location', '/login');
    await request(app.getHttpServer())
      .get('/profile')
      .expect(302)
      .expect('Location', '/login');

    const agent = request.agent(app.getHttpServer());
    const loginPage = await agent.get('/login').expect(200);
    expect(loginPage.text).toContain('action="/oauth/login"');
    expect(loginPage.text).toContain('name="loginId"');
    expect(loginPage.text).toContain('action="/oauth/login/social/google"');
    expect(loginPage.text).toContain('action="/oauth/login/social/kakao"');
    expect(loginPage.text).not.toContain('action="/oauth/login/social/naver"');

    const login = await loginLocal(agent, local.loginId, local.password);
    expect(login.target).toBe(`${ISSUER}/`);
    await agent
      .get('/')
      .expect(200)
      .expect('Content-Type', /html/)
      .expect((response) => {
        expect(response.text).toContain('/portal/assets/portal.js');
      });
    await agent.get('/profile').expect(200).expect('Content-Type', /html/);

    const overview = await agent.get('/api/portal/me').expect(200);
    expect(overview.headers['cache-control']).toBe('no-store');
    expect(overview.body.account).toEqual(
      expect.objectContaining({
        id: local.account.id,
        loginId: local.loginId,
        name: local.account.name,
        email: local.account.email,
        hasLocalCredentials: true,
      }),
    );
    expect(overview.body.services).toEqual([
      expect.objectContaining({
        key: expect.stringMatching(/^portal-member-/),
        permission: { key: 'member', label: 'Member' },
      }),
    ]);
    expect(overview.body.socialProviders).toEqual([
      {
        key: 'google',
        label: 'Google',
        linked: false,
        enabled: true,
        linkedAt: null,
      },
      {
        key: 'kakao',
        label: 'Kakao',
        linked: false,
        enabled: true,
        linkedAt: null,
      },
    ]);
    expect(JSON.stringify(overview.body)).not.toContain(GOOGLE_CLIENT_ID);
    expect(JSON.stringify(overview.body)).not.toContain(GOOGLE_CLIENT_SECRET);
    expect(JSON.stringify(overview.body)).not.toContain(KAKAO_CLIENT_ID);
    expect(JSON.stringify(overview.body)).not.toContain(KAKAO_CLIENT_SECRET);
    expect(overview.body.csrfToken).toEqual(expect.any(String));
  });

  it('enforces CSRF and keeps the existing name and login ID immutable', async () => {
    const agent = request.agent(app.getHttpServer());
    await loginLocal(agent, local.loginId, local.password);
    const overview = await agent.get('/api/portal/me').expect(200);
    const csrf = overview.body.csrfToken as string;
    const nextPassword = 'Portal-next-password!';

    await agent
      .post('/api/portal/password')
      .send({
        currentPassword: local.password,
        password: nextPassword,
        passwordConfirm: nextPassword,
      })
      .expect(403);
    await agent
      .post('/api/portal/password')
      .set('X-CSRF-Token', 'invalid')
      .send({
        currentPassword: local.password,
        password: nextPassword,
        passwordConfirm: nextPassword,
      })
      .expect(403);
    await agent
      .post('/api/portal/password')
      .set('Origin', 'https://attacker.example.test')
      .set('X-CSRF-Token', csrf)
      .send({
        currentPassword: local.password,
        password: nextPassword,
        passwordConfirm: nextPassword,
      })
      .expect(403);

    await agent
      .post('/api/portal/password')
      .set('X-CSRF-Token', csrf)
      .send({
        currentPassword: 'wrong-password',
        password: nextPassword,
        passwordConfirm: nextPassword,
      })
      .expect(401)
      .expect((response) => {
        expect(response.body.code).toBe('invalid_current_password');
      });

    const emailStart = await agent
      .post('/api/portal/email/start')
      .set('X-CSRF-Token', csrf)
      .send({
        email: `portal-email-${randomUUID()}@example.test`,
        currentPassword: local.password,
      })
      .expect(200);
    await agent
      .post('/api/portal/email/complete')
      .set('X-CSRF-Token', csrf)
      .send({
        verificationId: emailStart.body.verificationId,
        code: '000000',
      })
      .expect(401)
      .expect((response) => {
        expect(response.body.code).toBe('invalid_email_verification');
      });

    await agent
      .post('/api/portal/password')
      .set('X-CSRF-Token', csrf)
      .send({
        name: 'Changed Name',
        currentPassword: local.password,
        password: nextPassword,
        passwordConfirm: nextPassword,
      })
      .expect(400);
    await agent
      .post('/api/portal/password')
      .set('X-CSRF-Token', csrf)
      .send({
        loginId: `${local.loginId}-changed`,
        currentPassword: local.password,
        password: nextPassword,
        passwordConfirm: nextPassword,
      })
      .expect(400);

    const unchanged = await db
      .getRepository(AccountEntity)
      .findOneByOrFail({ id: local.account.id });
    expect(unchanged.name).toBe(local.account.name);
    expect(unchanged.loginId).toBe(local.loginId);
    expect(unchanged.credentialVersion).toBe(local.account.credentialVersion);
  });

  it('links a provider with a different email and rejects an identity owned by another account', async () => {
    const agent = request.agent(app.getHttpServer());
    await loginLocal(agent, local.loginId, local.password);
    const overview = await agent.get('/api/portal/me').expect(200);
    const csrf = overview.body.csrfToken as string;
    const linkedSubject = `portal-link-${randomUUID()}`;
    const linkedProfile: SocialIdentityProfile = {
      provider: 'kakao',
      providerClientId: KAKAO_CLIENT_ID,
      subject: linkedSubject,
      email: `different-provider-${randomUUID()}@example.test`,
      emailVerified: true,
      name: 'Different Provider User',
    };

    const firstState = await startSocialLink(agent, csrf, 'kakao');
    exchangeCode.mockResolvedValueOnce(linkedProfile);
    const linked = await agent
      .get('/oauth/social/kakao/callback')
      .query({ state: firstState, code: 'portal-link-code' })
      .expect(200);
    const linkedTarget = new URL(redirectTarget(linked));
    expect(linkedTarget.pathname).toBe('/profile');
    expect(linkedTarget.searchParams.get('linked')).toBe('kakao');
    expect(
      await db.getRepository(SocialIdentityEntity).findOneByOrFail({
        provider: 'kakao',
        providerClientId: KAKAO_CLIENT_ID,
        subject: linkedSubject,
      }),
    ).toEqual(expect.objectContaining({ accountId: local.account.id }));
    expect(
      (
        await db
          .getRepository(AccountEntity)
          .findOneByOrFail({ id: local.account.id })
      ).email,
    ).toBe(local.account.email);

    const owner = await createLocalAccount('portal-social-owner', false);
    const ownedSubject = `portal-owned-${randomUUID()}`;
    await db.getRepository(SocialIdentityEntity).save({
      accountId: owner.account.id,
      provider: 'kakao',
      providerClientId: KAKAO_CLIENT_ID,
      subject: ownedSubject,
    });
    const conflictState = await startSocialLink(agent, csrf, 'kakao');
    exchangeCode.mockResolvedValueOnce({
      ...linkedProfile,
      subject: ownedSubject,
      email: owner.account.email,
    });
    await agent
      .get('/oauth/social/kakao/callback')
      .query({ state: conflictState, code: 'portal-conflict-code' })
      .expect(409)
      .expect((response) => {
        expect(response.text).toContain(
          '이미 다른 계정에 연결된 소셜 계정입니다',
        );
      });
    const stillOwned = await db
      .getRepository(SocialIdentityEntity)
      .findOneByOrFail({
        provider: 'kakao',
        providerClientId: KAKAO_CLIENT_ID,
        subject: ownedSubject,
      });
    expect(stillOwned.accountId).toBe(owner.account.id);

    const logoutState = await startSocialLink(agent, csrf, 'kakao');
    const exchangeCount = exchangeCode.mock.calls.length;
    exchangeCode.mockRejectedValueOnce(
      new Error('Provider exchange must not run after portal logout'),
    );
    await agent
      .post('/api/portal/logout')
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(200)
      .expect({ ok: true });
    await agent
      .get('/oauth/social/kakao/callback')
      .query({ state: logoutState, code: 'portal-after-logout-code' })
      .expect(400);
    expect(exchangeCode).toHaveBeenCalledTimes(exchangeCount);
    exchangeCode.mockReset();
  });

  it('completes portal social primary login without an OIDC client registration', async () => {
    const suffix = randomUUID();
    const subject = `portal-primary-${suffix}`;
    const account = await db.transaction((manager) =>
      accounts.createSocialAccount(
        {
          email: `portal-primary-${suffix}@example.test`,
          name: 'Portal Primary Social',
        },
        manager,
      ),
    );
    await db.getRepository(SocialIdentityEntity).save({
      accountId: account.id,
      provider: 'google',
      providerClientId: GOOGLE_CLIENT_ID,
      subject,
    });
    const agent = request.agent(app.getHttpServer());
    const transaction = await loginTransaction(agent);
    const providerStart = await agent
      .post('/oauth/login/social/google')
      .type('form')
      .send({ login_transaction: transaction })
      .expect(200);
    const providerUrl = new URL(redirectTarget(providerStart));
    expect(providerUrl.origin).toBe('https://accounts.google.com');
    const state = providerUrl.searchParams.get('state');
    expect(state).toEqual(expect.any(String));

    exchangeCode.mockResolvedValueOnce({
      provider: 'google',
      providerClientId: GOOGLE_CLIENT_ID,
      subject,
      email: account.email,
      emailVerified: true,
      name: account.name,
    });
    const callback = await agent
      .get('/oauth/social/google/callback')
      .query({ state, code: 'portal-primary-code' })
      .expect(200);
    expect(redirectTarget(callback)).toBe(`${ISSUER}/`);
    await agent.get('/').expect(200).expect('Content-Type', /html/);
    await agent
      .get('/api/portal/me')
      .expect(200)
      .expect((response) => {
        expect(response.body.account).toEqual(
          expect.objectContaining({
            id: account.id,
            loginId: null,
            hasLocalCredentials: false,
          }),
        );
      });
  });

  it('changes a verified email without mutating immutable or linked identity fields', async () => {
    const agent = request.agent(app.getHttpServer());
    await loginLocal(agent, local.loginId, local.password);
    const overview = await agent.get('/api/portal/me').expect(200);
    const csrf = overview.body.csrfToken as string;
    const before = await db
      .getRepository(AccountEntity)
      .findOneByOrFail({ id: local.account.id });
    const identitiesBefore = await db.getRepository(SocialIdentityEntity).find({
      where: { accountId: local.account.id },
      order: { createdAt: 'ASC' },
    });
    expect(identitiesBefore).not.toHaveLength(0);
    const nextEmail = `portal-updated-${randomUUID()}@example.test`;

    const started = await agent
      .post('/api/portal/email/start')
      .set('X-CSRF-Token', csrf)
      .send({ email: nextEmail, currentPassword: local.password })
      .expect(200);
    const code = deliveredEmailCodes.get(nextEmail);
    if (!code) throw new Error('Portal email code was not delivered');
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    await agent
      .post('/api/portal/email/complete')
      .set('X-CSRF-Token', csrf)
      .send({ verificationId: started.body.verificationId, code })
      .expect(200)
      .expect({ reauthenticate: true });

    const changed = await db
      .getRepository(AccountEntity)
      .findOneByOrFail({ id: local.account.id });
    expect(changed).toEqual(
      expect.objectContaining({
        email: nextEmail,
        name: before.name,
        loginId: before.loginId,
        credentialVersion: before.credentialVersion + 1,
      }),
    );
    const identitiesAfter = await db.getRepository(SocialIdentityEntity).find({
      where: { accountId: local.account.id },
      order: { createdAt: 'ASC' },
    });
    expect(
      identitiesAfter.map(
        ({ id, accountId, provider, providerClientId, subject }) => ({
          id,
          accountId,
          provider,
          providerClientId,
          subject,
        }),
      ),
    ).toEqual(
      identitiesBefore.map(
        ({ id, accountId, provider, providerClientId, subject }) => ({
          id,
          accountId,
          provider,
          providerClientId,
          subject,
        }),
      ),
    );
    expect(
      await db.getRepository(TokenRecordEntity).countBy({
        accountId: local.account.id,
        type: 'portal_session',
        status: 'active',
      }),
    ).toBe(0);
    expect(
      await db.getRepository(TokenRecordEntity).countBy({
        accountId: local.account.id,
        type: 'sso_session',
        status: 'active',
      }),
    ).toBe(0);
    await agent.get('/api/portal/me').expect(401);
    await agent.get('/').expect(302).expect('Location', '/login');
  });

  it('revokes portal and SSO sessions when the credential version changes', async () => {
    const agent = request.agent(app.getHttpServer());
    await loginLocal(agent, local.loginId, local.password);
    const overview = await agent.get('/api/portal/me').expect(200);
    const previousVersion = (
      await db
        .getRepository(AccountEntity)
        .findOneByOrFail({ id: local.account.id })
    ).credentialVersion;
    const nextPassword = 'Portal-rotated-password!';

    await agent
      .post('/api/portal/password')
      .set('X-CSRF-Token', overview.body.csrfToken as string)
      .send({
        currentPassword: local.password,
        password: nextPassword,
        passwordConfirm: nextPassword,
      })
      .expect(200)
      .expect({ reauthenticate: true });

    const changed = await db
      .getRepository(AccountEntity)
      .findOneByOrFail({ id: local.account.id });
    expect(changed.credentialVersion).toBe(previousVersion + 1);
    expect(
      await db.getRepository(TokenRecordEntity).countBy({
        accountId: local.account.id,
        type: 'portal_session',
        status: 'active',
      }),
    ).toBe(0);
    expect(
      await db.getRepository(TokenRecordEntity).countBy({
        accountId: local.account.id,
        type: 'sso_session',
        status: 'active',
      }),
    ).toBe(0);
    await agent.get('/api/portal/me').expect(401);
    await agent.get('/').expect(302).expect('Location', '/login');

    const oldCredentials = request.agent(app.getHttpServer());
    const oldTransaction = await loginTransaction(oldCredentials);
    const failed = await oldCredentials
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: oldTransaction,
        loginId: local.loginId,
        password: local.password,
      })
      .expect(200);
    expect(failed.text).toContain('Invalid credentials');
    expect(failed.text).not.toContain('id="authorization-redirect"');

    const fresh = request.agent(app.getHttpServer());
    expect((await loginLocal(fresh, local.loginId, nextPassword)).target).toBe(
      `${ISSUER}/`,
    );
    await fresh.get('/api/portal/me').expect(200);
  });

  it('requires admin OTP before issuing admin or portal access and keeps /admin removed', async () => {
    const lockTarget = await createLocalAccount('portal-lock-target', false);
    const lockTargetAgent = request.agent(app.getHttpServer());
    await loginLocal(lockTargetAgent, lockTarget.loginId, lockTarget.password);
    await lockTargetAgent.get('/api/portal/me').expect(200);
    const agent = request.agent(app.getHttpServer());
    const primary = await loginLocal(agent, admin.loginId, admin.password);
    const otpUrl = new URL(primary.target);
    expect(otpUrl.pathname).toBe('/login/otp');
    const transaction = otpUrl.searchParams.get('transaction');
    expect(transaction).toEqual(expect.any(String));

    await agent.get('/').expect(302).expect('Location', '/login');
    await agent.get('/service').expect(404);
    await agent.get('/api/admin/session').expect(401);
    await agent.get('/admin').expect(404);
    await agent.get('/admin/').expect(404);
    await agent
      .get('/login/otp')
      .query({ transaction })
      .expect(200)
      .expect('Content-Type', /html/);

    const totp = app.get(TotpService);
    const code = (
      totp as unknown as {
        generateCode(secret: string, now: number): string;
      }
    ).generateCode(adminOtpSecret, Date.now());
    const wrongCode = `${code.slice(0, -1)}${(Number(code.at(-1)) + 1) % 10}`;
    await agent
      .post('/login/otp')
      .type('form')
      .send({ transaction, code: wrongCode })
      .expect(401);
    const verified = await agent
      .post('/login/otp')
      .type('form')
      .send({ transaction, code })
      .expect(200);
    expect(redirectTarget(verified)).toBe(`${ISSUER}/`);
    await agent
      .post('/login/otp')
      .type('form')
      .send({ transaction, code })
      .expect(400);

    await agent
      .get('/')
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain('<title>Teddy Auth Admin</title>');
      });
    await agent.get('/service').expect(200).expect('Content-Type', /html/);
    await agent
      .get('/api/admin/session')
      .expect(200)
      .expect((response) => {
        expect(response.body.account.id).toBe(admin.account.id);
      });
    await agent
      .patch(`/api/admin/accounts/${lockTarget.account.id}`)
      .send({ status: 'locked' })
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.objectContaining({
            id: lockTarget.account.id,
            status: 'locked',
            credentialVersion: lockTarget.account.credentialVersion + 1,
          }),
        );
      });
    expect(
      await db.getRepository(TokenRecordEntity).countBy({
        accountId: lockTarget.account.id,
        type: 'portal_session',
        status: 'active',
      }),
    ).toBe(0);
    expect(
      await db.getRepository(TokenRecordEntity).countBy({
        accountId: lockTarget.account.id,
        type: 'sso_session',
        status: 'active',
      }),
    ).toBe(0);
    await lockTargetAgent.get('/api/portal/me').expect(401);
    await lockTargetAgent.get('/').expect(302).expect('Location', '/login');
    await agent.get('/admin').expect(404);
  });

  it('lets a recent social-only portal session register local credentials', async () => {
    const suffix = randomUUID();
    const socialAccount = await db.transaction((manager) =>
      accounts.createSocialAccount(
        {
          email: `social-only-${suffix}@example.test`,
          name: 'Portal Social Only',
        },
        manager,
      ),
    );
    await db.getRepository(SocialIdentityEntity).save({
      accountId: socialAccount.id,
      provider: 'google',
      providerClientId: GOOGLE_CLIENT_ID,
      subject: `portal-social-${suffix}`,
    });
    const rawSession = randomBytes(32).toString('base64url');
    await db.getRepository(TokenRecordEntity).save({
      tokenHash: hashToken(rawSession),
      type: 'portal_session',
      status: 'active',
      accountId: socialAccount.id,
      clientId: 'auth-portal',
      familyId: null,
      serviceId: null,
      metadataJson: {
        credentialVersion: socialAccount.credentialVersion,
        authenticatedAt: new Date().toISOString(),
        method: 'social',
      },
      usedAt: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const portalCookie = signedPortalCookie(rawSession);
    const before = await request(app.getHttpServer())
      .get('/api/portal/me')
      .set('Cookie', portalCookie)
      .expect(200);
    expect(before.body.account).toEqual(
      expect.objectContaining({
        loginId: null,
        hasLocalCredentials: false,
      }),
    );
    expect(before.body.socialProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'google', linked: true, enabled: true }),
        expect.objectContaining({ key: 'kakao', linked: false, enabled: true }),
      ]),
    );

    const loginId = `social-local-${suffix}`;
    const password = 'Social-local-password!';
    await request(app.getHttpServer())
      .post('/api/portal/password')
      .set('Cookie', portalCookie)
      .set('X-CSRF-Token', before.body.csrfToken as string)
      .send({ loginId, password, passwordConfirm: password })
      .expect(200)
      .expect({ reauthenticate: true });

    const changed = await db
      .getRepository(AccountEntity)
      .findOneByOrFail({ id: socialAccount.id });
    expect(changed.loginId).toBe(loginId);
    expect(changed.passwordHash).toEqual(expect.any(String));
    expect(changed.credentialVersion).toBe(socialAccount.credentialVersion + 1);
    await request(app.getHttpServer())
      .get('/api/portal/me')
      .set('Cookie', portalCookie)
      .expect(401);

    const localAgent = request.agent(app.getHttpServer());
    expect((await loginLocal(localAgent, loginId, password)).target).toBe(
      `${ISSUER}/`,
    );
    await localAgent
      .get('/api/portal/me')
      .expect(200)
      .expect((response) => {
        expect(response.body.account).toEqual(
          expect.objectContaining({ loginId, hasLocalCredentials: true }),
        );
      });
  });

  it('switches a pre-existing user portal to a newly verified admin session', async () => {
    const agent = request.agent(app.getHttpServer());
    const user = await createLocalAccount('portal-before-admin', false);
    await loginLocal(agent, user.loginId, user.password);
    await agent
      .get('/api/portal/me')
      .expect(200)
      .expect((response) => {
        expect(response.body.account.id).toBe(user.account.id);
      });
    const totp = app.get(TotpService);
    await agent
      .post('/api/admin/login')
      .send({
        loginId: admin.loginId,
        password: admin.password,
        otpCode: (
          totp as unknown as {
            generateCode(secret: string, now: number): string;
          }
        ).generateCode(adminOtpSecret, Date.now()),
      })
      .expect(201);
    await agent
      .get('/')
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain('<title>Teddy Auth Admin</title>');
      });
    await agent
      .get('/api/portal/me')
      .expect(200)
      .expect((response) => {
        expect(response.body.account.id).toBe(admin.account.id);
      });
  });

  async function createLocalAccount(
    label: string,
    isSuperAdmin: boolean,
  ): Promise<LocalAccountFixture> {
    const suffix = randomUUID();
    const loginId = `${label}-${suffix}`;
    const password = 'Portal-test-password!';
    const account = await accounts.create(
      {
        loginId,
        name: isSuperAdmin ? 'Portal Admin' : 'Portal User',
        email: `${loginId}@example.test`,
        password,
        isSuperAdmin,
      },
      null,
      { emailVerifiedAt: new Date(), passwordResetRequired: false },
    );
    return { account, loginId, password };
  }

  async function configureAdminOtp(account: AccountEntity): Promise<string> {
    const totp = app.get(TotpService);
    const secret = totp.generateSecret();
    await db.getRepository(AdminMfaEntity).save({
      accountId: account.id,
      encryptedOtpSecret: app.get(AesGcmService).encrypt(secret),
      verifiedAt: new Date(),
    });
    return secret;
  }

  async function seedPortalServices(account: AccountEntity): Promise<void> {
    await seedAssignment(account.id, 'member', 'Member', 'portal-member');
    await seedAssignment(account.id, 'visitor', 'Visitor', 'portal-visitor');
    await seedAssignment(account.id, 'guest', 'Guest', 'portal-guest');
    const other = await createLocalAccount('portal-other', false);
    await seedAssignment(other.account.id, 'owner', 'Owner', 'portal-other');
  }

  async function seedAssignment(
    accountId: string,
    permissionKey: string,
    permissionLabel: string,
    servicePrefix: string,
  ): Promise<void> {
    const service = await db.getRepository(ServiceEntity).save({
      serviceKey: `${servicePrefix}-${randomUUID()}`,
      name: `${permissionLabel} Service`,
      description: `${permissionLabel} portal fixture`,
      status: 'active',
    });
    const permission = await db
      .getRepository(ServicePermissionDefinitionEntity)
      .save({
        serviceId: service.id,
        key: permissionKey,
        label: permissionLabel,
        description: '',
        status: 'active',
        sortOrder: 0,
        deprecatedAt: null,
        removedAt: null,
      });
    await db.getRepository(AccountServicePermissionEntity).save({
      accountId,
      serviceId: service.id,
      permissionDefinitionId: permission.id,
      status: 'active',
      grantedByAccountId: admin.account.id,
      grantedAt: new Date(),
      revokedAt: null,
    });
  }

  async function startSocialLink(
    agent: PortalAgent,
    csrf: string,
    provider: string,
  ): Promise<string> {
    const start = await agent
      .post(`/api/portal/social/${provider}/link`)
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(200);
    const continueUrl = new URL(start.body.redirectUrl as string, ISSUER);
    const state = continueUrl.searchParams.get('transaction');
    expect(state).toEqual(expect.any(String));
    const continued = await agent
      .get(`${continueUrl.pathname}${continueUrl.search}`)
      .expect(200);
    expect(redirectTarget(continued)).toMatch(
      /^https:\/\/kauth\.kakao\.com\/oauth\/authorize\?/,
    );
    return state!;
  }

  async function loginTransaction(agent: PortalAgent): Promise<string> {
    const response = await agent.get('/login').expect(200);
    const match = response.text.match(
      /name="login_transaction" value="([^"]+)"/,
    );
    expect(match).not.toBeNull();
    return match![1];
  }

  async function loginLocal(
    agent: PortalAgent,
    loginId: string,
    password: string,
  ): Promise<{ response: request.Response; target: string }> {
    const transaction = await loginTransaction(agent);
    const response = await agent
      .post('/oauth/login')
      .type('form')
      .send({ login_transaction: transaction, loginId, password })
      .expect(200);
    return { response, target: redirectTarget(response) };
  }

  function redirectTarget(response: request.Response): string {
    const match = response.text.match(
      /id="authorization-redirect" href="([^"]+)"/,
    );
    expect(match).not.toBeNull();
    return match![1].replaceAll('&amp;', '&');
  }

  function signedPortalCookie(raw: string): string {
    const signature = createHmac('sha256', COOKIE_SECRET)
      .update(raw)
      .digest('base64')
      .replace(/=+$/, '');
    return `tas_portal_session=${encodeURIComponent(`s:${raw}.${signature}`)}`;
  }
});
