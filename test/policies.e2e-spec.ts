import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AccountPolicyConsentEntity } from '../src/database/entities/account-policy-consent.entity';
import { AccountEntity } from '../src/database/entities/account.entity';
import { EmailVerificationEntity } from '../src/database/entities/email-verification.entity';
import { TokenRecordEntity } from '../src/database/entities/token-record.entity';
import { AccountsService } from '../src/domain/accounts/accounts.service';
import { AccountPoliciesService } from '../src/policies/account-policies.service';
import { PolicyAcceptanceDto } from '../src/policies/policy-acceptance.dto';
import { EmailDeliveryService } from '../src/signup/email-delivery.service';

const describeIsolated = process.env.TEST_DATABASE_URL
  ? describe
  : describe.skip;
const originalEnv = { ...process.env };
jest.setTimeout(30_000);

describeIsolated('Policy consent (dedicated isolated HTTP e2e)', () => {
  let app: INestApplication;
  let db: DataSource;
  const requestIp = `2001:db8::${randomUUID().slice(0, 4)}`;
  const codes = new Map<string, string>();
  const sendSignupCode = jest.fn(async (email: string, code: string) => {
    codes.set(email, code);
  });

  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !/^auth_portal_e2e(?:_[a-z0-9_]+)?$/.test(
        decodeURIComponent(url.pathname.replace(/^\/+/, '')),
      ) ||
      [...url.searchParams.keys()].some((key) =>
        ['database', 'dbname'].includes(key.toLowerCase()),
      )
    ) {
      throw new Error(
        'Policy e2e requires the dedicated auth_portal_e2e PostgreSQL database without database query overrides',
      );
    }
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      RUN_MIGRATIONS: 'false',
      NOTIFICATIONS_ENABLED: 'false',
      PERMISSION_WEBHOOKS_ENABLED: 'false',
      ISSUER_URL: 'http://localhost:3032',
      COOKIE_SECRET: 'policies-e2e-cookie-secret',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailDeliveryService)
      .useValue({ sendSignupCode })
      .compile();
    app = moduleRef.createNestApplication();
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
    await db.getRepository(EmailVerificationEntity).clear();
  });

  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
    for (const key of Object.keys(process.env))
      if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  async function agreement(): Promise<PolicyAcceptanceDto> {
    const response = await request(app.getHttpServer())
      .get('/api/public/policies')
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const { termsVersion, privacyVersion, policyDigest } = response.body as {
      termsVersion: string;
      privacyVersion: string;
      policyDigest: string;
    };
    return {
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion,
      privacyVersion,
      policyDigest,
    };
  }

  async function signupFixture() {
    const email = `policies-${randomUUID()}@example.test`;
    const response = await request(app.getHttpServer())
      .post('/api/signup/start')
      .set('X-Forwarded-For', requestIp)
      .send({ email })
      .expect(201);
    const code = codes.get(email);
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    const input = {
      loginId: `policies-${randomUUID()}`,
      name: 'Policy User',
      email,
      password: 'Policy-password!123',
      code: code!,
    };
    return { input, verificationId: response.body.verificationId as string };
  }

  async function localFixture() {
    const id = randomUUID();
    const password = 'Policy-existing-password!';
    const account = await app.get(AccountsService).create(
      {
        loginId: `policies-existing-${id}`,
        name: 'Existing Policy User',
        email: `policies-existing-${id}@example.test`,
        password,
        isSuperAdmin: false,
      },
      null,
      { emailVerifiedAt: new Date(), passwordResetRequired: false },
    );
    return { account, password };
  }

  async function login(fixture: Awaited<ReturnType<typeof localFixture>>) {
    const agent = request.agent(app.getHttpServer());
    const page = await agent.get('/login').expect(200);
    const transaction = page.text.match(
      /name="login_transaction" value="([^"]+)"/,
    )![1];
    await agent
      .post('/oauth/login')
      .type('form')
      .send({
        login_transaction: transaction,
        loginId: fixture.account.loginId!,
        password: fixture.password,
      })
      .expect(200);
    const me = await agent.get('/api/portal/me').expect(200);
    return { agent, csrf: me.body.csrfToken as string };
  }

  it('publishes current versions, digest and public policy URLs without authentication', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/public/policies')
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      termsVersion: '2026-11-18',
      privacyVersion: '2026-11-18',
      policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      termsUrl: '/terms',
      privacyUrl: '/privacy',
    });
    for (const path of [
      response.body.termsUrl as string,
      response.body.privacyUrl as string,
    ]) {
      await request(app.getHttpServer())
        .get(path)
        .expect(200)
        .expect('Content-Type', /html/);
    }
  });

  it.each(['json', 'form'])(
    'rejects missing, false and stale %s agreement without creating an account or consuming OTP',
    async (encoding) => {
      const { input, verificationId } = await signupFixture();
      const policy = await agreement();
      const invalid: Array<Record<string, unknown>> = [
        {},
        ...Object.keys(policy).map((field) => {
          const candidate: Record<string, unknown> = { ...policy };
          delete candidate[field];
          return candidate;
        }),
        { ...policy, termsAccepted: false },
        { ...policy, privacyAccepted: false },
        { ...policy, termsVersion: 'previous' },
        { ...policy, privacyVersion: 'previous' },
        { ...policy, policyDigest: '0'.repeat(64) },
        { ...policy, termsUrl: '/terms' },
        { ...policy, privacyUrl: '/privacy' },
      ];
      for (const fields of invalid) {
        await request(app.getHttpServer())
          .post('/api/signup/complete')
          .type(encoding)
          .send({ ...input, ...fields })
          .expect(400);
        expect(
          await db.getRepository(AccountEntity).countBy({ email: input.email }),
        ).toBe(0);
        const proof = await db
          .getRepository(EmailVerificationEntity)
          .findOneByOrFail({ id: verificationId });
        expect(proof.consumedAt).toBeNull();
        expect(proof.attemptCount).toBe(0);
      }
      await request(app.getHttpServer())
        .post('/api/signup/verify-code')
        .send({ email: input.email, code: input.code })
        .expect(201);
      const response = await request(app.getHttpServer())
        .post('/api/signup/complete')
        .type(encoding)
        .send({ ...input, ...policy })
        .expect(201);
      const account = await db
        .getRepository(AccountEntity)
        .findOneByOrFail({ id: response.body.account.id as string });
      expect(account).toMatchObject({
        loginId: input.loginId,
        name: input.name,
        email: input.email,
        isSuperAdmin: false,
      });
      expect(account.emailVerifiedAt).toBeInstanceOf(Date);
      expect(account.passwordHash).toEqual(expect.any(String));
      const { termsVersion, privacyVersion, policyDigest } = policy;
      expect(
        await db
          .getRepository(AccountPolicyConsentEntity)
          .findBy({ accountId: account.id }),
      ).toEqual([
        expect.objectContaining({
          accountId: account.id,
          termsVersion,
          privacyVersion,
          policyDigest,
          source: 'signup',
          acceptedAt: expect.any(Date),
        }),
      ]);
      expect(
        (
          await db
            .getRepository(EmailVerificationEntity)
            .findOneByOrFail({ id: verificationId })
        ).consumedAt,
      ).toBeInstanceOf(Date);
      expect(response.body.account).not.toHaveProperty('passwordHash');
    },
  );

  it('rolls back the new account and consent on persistence failure, retaining the same email and OTP for retry', async () => {
    const { input, verificationId } = await signupFixture();
    const policy = await agreement();
    const policies = app.get(AccountPoliciesService);
    const originalRecord = policies.record.bind(
      policies,
    ) as AccountPoliciesService['record'];
    const record = jest
      .spyOn(policies, 'record')
      .mockImplementationOnce(async (...args) => {
        await originalRecord(...args);
        throw new Error('Injected consent persistence failure');
      });
    try {
      await request(app.getHttpServer())
        .post('/api/signup/complete')
        .send({ ...input, ...policy })
        .expect(500);
    } finally {
      record.mockRestore();
    }
    expect(
      await db.getRepository(AccountEntity).countBy({ email: input.email }),
    ).toBe(0);
    expect(
      (
        await db
          .getRepository(EmailVerificationEntity)
          .findOneByOrFail({ id: verificationId })
      ).consumedAt,
    ).toBeNull();
    await request(app.getHttpServer())
      .post('/api/signup/complete')
      .send({ ...input, ...policy })
      .expect(201);
    expect(
      await db.getRepository(AccountEntity).countBy({ email: input.email }),
    ).toBe(1);
  });

  it('never backfills acceptance for an existing account through login or profile reads', async () => {
    const fixture = await localFixture();
    const { agent } = await login(fixture);
    await agent.get('/profile').expect(200);
    for (let index = 0; index < 2; index++) {
      const response = await agent.get('/api/portal/policies').expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toMatchObject({
        accepted: false,
        acceptedAt: null,
      });
    }
    expect(
      await db
        .getRepository(AccountPolicyConsentEntity)
        .countBy({ accountId: fixture.account.id }),
    ).toBe(0);
  });

  it('requires authentication, same-origin access and CSRF for portal acceptance', async () => {
    const policy = await agreement();
    await request(app.getHttpServer()).get('/api/portal/policies').expect(401);
    await request(app.getHttpServer())
      .post('/api/portal/policies')
      .send(policy)
      .expect(401);
    const first = await localFixture();
    const second = await localFixture();
    const { agent, csrf } = await login(first);
    const other = await login(second);
    for (const token of [undefined, 'invalid', other.csrf]) {
      const post = agent.post('/api/portal/policies');
      if (token) post.set('X-CSRF-Token', token);
      await post.send(policy).expect(403);
    }
    await agent
      .get('/api/portal/policies')
      .set('Origin', 'https://attacker.example')
      .expect(403);
    await agent
      .post('/api/portal/policies')
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'https://attacker.example')
      .send(policy)
      .expect(403);
    await agent
      .post('/api/portal/policies')
      .set('X-CSRF-Token', csrf)
      .send({ ...policy, accountId: second.account.id })
      .expect(400);
    await agent
      .post('/api/portal/policies')
      .set('X-CSRF-Token', csrf)
      .send({ ...policy, policyDigest: '0'.repeat(64) })
      .expect(400);
    for (const accountId of [first.account.id, second.account.id])
      expect(
        await db
          .getRepository(AccountPolicyConsentEntity)
          .countBy({ accountId }),
      ).toBe(0);
    const response = await agent
      .post('/api/portal/policies')
      .set('X-CSRF-Token', csrf)
      .send(policy)
      .expect(200);
    expect(response.body).toMatchObject({
      accepted: true,
      acceptedAt: expect.any(String),
    });
    await agent
      .post('/api/portal/policies')
      .set('X-CSRF-Token', csrf)
      .send(policy)
      .expect(200);
    const recorded = await db
      .getRepository(AccountPolicyConsentEntity)
      .findBy({ accountId: first.account.id });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      source: 'portal',
      termsVersion: policy.termsVersion,
      privacyVersion: policy.privacyVersion,
      policyDigest: policy.policyDigest,
    });
    expect(
      await db
        .getRepository(AccountPolicyConsentEntity)
        .countBy({ accountId: second.account.id }),
    ).toBe(0);
    expect(
      (await agent.get('/api/portal/policies').expect(200)).body.acceptedAt,
    ).toBe(response.body.acceptedAt);
  });

  it('rejects old CSRF after changing accounts and rejects acceptance after logout', async () => {
    const first = await localFixture();
    const second = await localFixture();
    const oldSession = await login(first);
    const current = await login(second);
    const policy = await agreement();
    await current.agent
      .post('/api/portal/policies')
      .set('X-CSRF-Token', oldSession.csrf)
      .send(policy)
      .expect(403);
    await current.agent
      .post('/api/portal/logout')
      .set('X-CSRF-Token', current.csrf)
      .send({})
      .expect(200);
    await current.agent.get('/api/portal/policies').expect(401);
    await current.agent
      .post('/api/portal/policies')
      .set('X-CSRF-Token', current.csrf)
      .send(policy)
      .expect(401);
    for (const accountId of [first.account.id, second.account.id])
      expect(
        await db
          .getRepository(AccountPolicyConsentEntity)
          .countBy({ accountId }),
      ).toBe(0);
  });

  it.each(['revoked', 'expired', 'credential-change', 'account-mismatch'])(
    'rejects a %s portal session before any consent write',
    async (change) => {
      const fixture = await localFixture();
      const { agent, csrf } = await login(fixture);
      const session = await db
        .getRepository(TokenRecordEntity)
        .findOneByOrFail({
          accountId: fixture.account.id,
          type: 'portal_session',
          status: 'active',
        });
      if (change === 'revoked')
        await db
          .getRepository(TokenRecordEntity)
          .update(session.id, { status: 'revoked' });
      if (change === 'expired')
        await db
          .getRepository(TokenRecordEntity)
          .update(session.id, { expiresAt: new Date(0) });
      if (change === 'credential-change')
        await db.getRepository(AccountEntity).update(fixture.account.id, {
          credentialVersion: fixture.account.credentialVersion + 1,
        });
      if (change === 'account-mismatch') {
        const other = await localFixture();
        await db.getRepository(TokenRecordEntity).update(session.id, {
          accountId: other.account.id,
          metadataJson: {
            ...session.metadataJson,
            credentialVersion: other.account.credentialVersion + 1,
          },
        });
      }
      await agent
        .post('/api/portal/policies')
        .set('X-CSRF-Token', csrf)
        .send(await agreement())
        .expect(401);
      expect(
        await db
          .getRepository(AccountPolicyConsentEntity)
          .countBy({ accountId: fixture.account.id }),
      ).toBe(0);
    },
  );
});
