import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AesGcmService } from '../src/common/crypto/aes-gcm.service';
import { TotpService } from '../src/common/crypto/totp.service';
import { AccountServicePermissionEntity } from '../src/database/entities/account-service-permission.entity';
import { AdminMfaEntity } from '../src/database/entities/admin-mfa.entity';
import { OidcClientEntity } from '../src/database/entities/oidc-client.entity';
import { ServiceCredentialEntity } from '../src/database/entities/service-credential.entity';
import { ServicePermissionDefinitionEntity } from '../src/database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../src/database/entities/service.entity';
import { AccountsService } from '../src/domain/accounts/accounts.service';
import { ServiceOnboardingService } from '../src/domain/service-onboarding/service-onboarding.service';
import { TokenService } from '../src/oidc/token.service';

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
    const otpSecret = 'JBSWY3DPEHPK3PXP';
    const accounts = app.get(AccountsService);
    const aes = app.get(AesGcmService);
    const totp = app.get(TotpService);
    const account = await accounts.create({
      loginId,
      name: 'E2E Super Admin',
      email: `${loginId}@lafamila.xyz`,
      password,
      isSuperAdmin: true,
    });
    await dataSource.getRepository(AdminMfaEntity).save(
      dataSource.getRepository(AdminMfaEntity).create({
        account,
        accountId: account.id,
        encryptedOtpSecret: aes.encrypt(otpSecret),
        verifiedAt: new Date(),
      }),
    );
    const otpCode = (totp as unknown as { generateCode(secret: string, now: number): string })
      .generateCode(otpSecret, Date.now());
    const response = await request(app.getHttpServer())
      .post('/api/admin/login')
      .send({ loginId, password, otpCode })
      .expect(201);
    const setCookie = response.headers['set-cookie'];
    return Array.isArray(setCookie) ? setCookie : [setCookie];
  }

  async function createAccount(input?: Partial<{ loginId: string; email: string; name: string; password: string }>) {
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
    }>;
    serviceCredentials?: Array<{
      name: string;
      description?: string;
      scopes: Array<'account.search' | 'permission.read'>;
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
    const createResponse = (await onboarding.create(requestBody, null)) as unknown as {
      request: { id: string };
    };
    const approvalResponse = await request(app.getHttpServer())
      .post(`/api/admin/service-onboarding-requests/${createResponse.request.id}/approve`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(201);
    const service = await dataSource
      .getRepository(ServiceEntity)
      .findOneByOrFail({ serviceKey });
    const permissions = await dataSource.getRepository(ServicePermissionDefinitionEntity).find({
      where: { serviceId: service.id },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return {
      approval: approvalResponse.body,
      service,
      permissionsByKey: new Map(permissions.map((permission) => [permission.key, permission])),
    };
  }

  async function loginAgent(loginId: string, password: string) {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/login')
      .send({
        loginId,
        password,
      })
      .expect(201);
    return agent;
  }

  async function authorizeAndExchange(agent: request.Agent, input: {
    clientId: string;
    redirectUri: string;
    expectedServiceKey: string;
    expectedPermission: string;
  }) {
    const codeVerifier = `verifier-${nextSuffix('pkce')}`;
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const authorizeResponse = await agent
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        scope: 'openid profile email service.permission',
        state: 'state',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      })
      .expect(302);
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

    const payload = app.get(TokenService).verifyAccessToken(tokenResponse.body.access_token);
    expect(payload.aud).toBe(`service:${input.expectedServiceKey}`);
    expect(payload['https://lafamila.xyz/claims/service']).toEqual(
      expect.objectContaining({
        key: input.expectedServiceKey,
        permission: input.expectedPermission,
      }),
    );
    return tokenResponse.body as { access_token: string; refresh_token: string };
  }

  it('boots the full app and serves health', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('serves the cleaned admin UI surface', async () => {
    const adminHtml = readFileSync(
      join(process.cwd(), 'public', 'index.html'),
      'utf8',
    );
    expect(adminHtml).toContain('Service Onboarding Requests');
    expect(adminHtml).toContain('Account Access Requests');
    expect(adminHtml).not.toContain('Create Account');
    expect(adminHtml).not.toContain('Create Service');
    expect(adminHtml).not.toContain('Create Service Credential');
    expect(adminHtml).not.toContain('Add Permission');
    expect(adminHtml).not.toContain('Create OIDC Client');
    expect(adminHtml).not.toContain('Assign Service Permission');
  });

  it('removes direct admin write endpoints while keeping read and operational routes', async () => {
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
    const clientId = await dataSource.getRepository(OidcClientEntity).findOneByOrFail({
      serviceId,
    });
    const credential = await dataSource.getRepository(ServiceCredentialEntity).findOneByOrFail({
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
      .post(`/api/admin/services/${serviceId}/permissions/${visitorId}/deprecate`)
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
      .post(`/api/admin/services/${serviceId}/clients/${clientId.id}/rotate-secret`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceId}/credentials`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/admin/services/${serviceId}/credentials/${credential.id}`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .put(`/api/admin/accounts/${account.id}/services/${serviceId}/permission`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/admin/accounts/${account.id}/services/${serviceId}/permission`)
      .set('Cookie', adminCookie)
      .expect(404);
  });

  it('keeps service credential rotate and disable operations after onboarding approval', async () => {
    const approved = await createApprovedService({
      serviceCredentials: [
        {
          name: 'todo-api local',
          description: 'account search integration',
          scopes: ['account.search', 'permission.read'],
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
              scopes: ['account.search', 'permission.read'],
              status: 'active',
            }),
          ]),
        );
        expect(response.body[0].secret).toBeUndefined();
        expect(response.body[0].secretHash).toBeUndefined();
      });

    const rotateResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${approved.service.id}/credentials/${credential.id}/rotate`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(201);
    expect(rotateResponse.body.secret).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/api/admin/services/${approved.service.id}/credentials/${credential.id}/disable`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(201)
      .expect((response) => {
        expect(response.body.status).toBe('disabled');
      });

    await request(app.getHttpServer())
      .post(`/api/admin/services/${approved.service.id}/credentials/${credential.id}/rotate`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(400)
      .expect((response) => {
        expect(response.body.message).toBe('Disabled credentials cannot be rotated');
      });
  });

  it('lazily grants visitor to a newly created account on first service login and supports access request approval', async () => {
    const clientId = nextSuffix('lazy-existing-service-client');
    const approved = await createApprovedService({
      permissions: [{ key: 'admin', label: 'Admin', description: 'Elevated access' }],
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

    const agent = await loginAgent(account.loginId, password);
    const visitorTokens = await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'bodylab://auth/callback',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
    });

    const visitorAssignment = await dataSource
      .getRepository(AccountServicePermissionEntity)
      .findOneOrFail({
        where: { accountId: account.id, serviceId: approved.service.id },
        relations: { permissionDefinition: true },
      });
    expect(visitorAssignment.permissionDefinition.key).toBe('visitor');

    const applicationResponse = await request(app.getHttpServer())
      .post('/api/service-applications')
      .set('authorization', `Bearer ${visitorTokens.access_token}`)
      .send({
        serviceKey: approved.service.serviceKey,
        message: 'I need access for testing.',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/admin/service-applications/${applicationResponse.body.id}/approve`)
      .set('Cookie', adminCookie)
      .send({
        targetPermissionDefinitionId: approved.permissionsByKey.get('admin')?.id,
      })
      .expect(201);

    await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'bodylab://auth/callback',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'admin',
    });
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

    const agent = await loginAgent(account.loginId, password);
    await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'bodylab-mac://auth/callback',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
    });

    const assignment = await dataSource
      .getRepository(AccountServicePermissionEntity)
      .findOneOrFail({
        where: { accountId: account.id, serviceId: approved.service.id },
        relations: { permissionDefinition: true },
      });
    expect(assignment.permissionDefinition.key).toBe('visitor');
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
    const agent = await loginAgent(account.loginId, password);

    await authorizeAndExchange(agent, {
      clientId,
      redirectUri: 'revoked://auth/callback',
      expectedServiceKey: approved.service.serviceKey,
      expectedPermission: 'visitor',
    });

    const assignmentRepository = dataSource.getRepository(AccountServicePermissionEntity);
    const assignment = await assignmentRepository.findOneByOrFail({
      accountId: account.id,
      serviceId: approved.service.id,
    });
    assignment.status = 'revoked';
    assignment.revokedAt = new Date();
    await assignmentRepository.save(assignment);

    const codeVerifier = `verifier-${nextSuffix('revoked')}`;
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
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
    expect(redirect.searchParams.get('error_description')).toBe('No service permission');

    const persisted = await assignmentRepository.findOneByOrFail({ id: assignment.id });
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
      (secret) => secret.kind === 'service_credential' && secret.name === 'search credential',
    );
    const wrongScopeSecret = todoApproved.approval.secrets.find(
      (secret) =>
        secret.kind === 'service_credential' && secret.name === 'wrong scope credential',
    );
    expect(searchSecret).toBeTruthy();
    expect(wrongScopeSecret).toBeTruthy();

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .query({ serviceKey: todoApproved.service.serviceKey, q: account.loginId.slice(0, 4) })
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchSecret?.keyId as string)
      .set('x-auth-service-secret', 'wrong-secret')
      .query({ serviceKey: todoApproved.service.serviceKey, q: account.loginId.slice(0, 4) })
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', wrongScopeSecret?.keyId as string)
      .set('x-auth-service-secret', wrongScopeSecret?.secret as string)
      .query({ serviceKey: todoApproved.service.serviceKey, q: account.loginId.slice(0, 4) })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchSecret?.keyId as string)
      .set('x-auth-service-secret', searchSecret?.secret as string)
      .query({ serviceKey: otherApproved.service.serviceKey, q: account.loginId.slice(0, 4) })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchSecret?.keyId as string)
      .set('x-auth-service-secret', searchSecret?.secret as string)
      .query({ serviceKey: todoApproved.service.serviceKey, q: account.loginId.slice(0, 4) })
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
      .post(`/api/admin/services/${todoApproved.service.id}/credentials/${searchCredential.id}/disable`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchSecret?.keyId as string)
      .set('x-auth-service-secret', searchSecret?.secret as string)
      .query({ serviceKey: todoApproved.service.serviceKey, q: account.loginId.slice(0, 4) })
      .expect(401);
  });
});
