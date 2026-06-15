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
    expect(adminHtml).toContain('I copied these secrets');
    expect(adminHtml).toContain('Concrete .env examples');
    expect(adminHtml).toContain('[hidden]');
    expect(adminHtml).toContain('display: none !important;');
    expect(adminHtml).toContain("mode === 'bootstrap' && state.requiresBootstrap");
    expect(adminHtml).toContain(
      'Bootstrap is unavailable because an active superadmin already exists.',
    );
    expect(adminHtml).toContain("state.adminSession ? 'Logout' : 'Admin Session'");
    expect(adminHtml).not.toContain('adminSessionForm');
    expect(adminHtml).not.toContain('adminLogout');
    expect(adminHtml).not.toContain("$('secretModal').addEventListener('click'");
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
        expect(response.text).not.toContain('Create Service Onboarding Request');
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
    expect(serviceHtml).toContain('serviceRequestImportMessage');
    expect(serviceHtml).toContain('service-request-import.js');
    expect(serviceHtml).toContain('JSON Preview');
    expect(serviceHtml).toContain('Request-update-only secret');
    expect(serviceHtml).toContain('Admin Session required');
    expect(serviceHtml).toContain('Unknown JSON fields are ignored and reported as warnings.');
    expect(serviceHtml).toContain('visitor permission is');
    expect(serviceHtml).toContain('readonly');
    expect(serviceHtml).toContain('Requester identity always comes from');
    expect(serviceHtml).toContain("mode === 'bootstrap' && state.requiresBootstrap");
    expect(serviceHtml).toContain(
      'Bootstrap is unavailable because an active superadmin already exists.',
    );
    expect(serviceHtml).toContain("state.adminSession ? 'Logout' : 'Admin Session'");
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
      });
  });

  it('creates and revises a pending service onboarding request with its request secret', async () => {
    const suffix = nextSuffix('pending-update');
    const serviceKey = suffix;
    const createResponse = await request(app.getHttpServer())
      .post('/api/service-onboarding-requests')
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
      .post(`/api/service-onboarding-requests/${createResponse.body.request.id}/update`)
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

    const requests = await dataSource.getRepository(ServiceOnboardingRequestEntity).find({
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
