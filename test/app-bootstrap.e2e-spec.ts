import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AccountServicePermissionEntity } from '../src/database/entities/account-service-permission.entity';
import { AccountEntity } from '../src/database/entities/account.entity';
import { OidcClientEntity } from '../src/database/entities/oidc-client.entity';
import { ServiceCredentialEntity } from '../src/database/entities/service-credential.entity';
import { ServicePermissionDefinitionEntity } from '../src/database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../src/database/entities/service.entity';
import { TokenService } from '../src/oidc/token.service';

describe('App bootstrap (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL =
      process.env.TEST_DATABASE_URL ??
      'postgres://postgres:postgres@localhost:35432/teddy_auth';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.COOKIE_SECRET = 'test-cookie-secret';
    process.env.SEED_ADMIN_LOGIN_ID = 'superadmin-test';
    process.env.SEED_ADMIN_PASSWORD = 'superadmin-password';
    process.env.SEED_ADMIN_EMAIL = 'superadmin-test@lafamila.xyz';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('boots the full app and serves health', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('grants visitor permission when services and accounts are created', async () => {
    const suffix = Date.now();
    const serviceResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('x-admin-key', 'test-admin-key')
      .send({
        serviceKey: `todo-${suffix}`,
        name: `Todo ${suffix}`,
      })
      .expect(201);

    const serviceId = serviceResponse.body.id as string;
    const visitor = await dataSource
      .getRepository(ServicePermissionDefinitionEntity)
      .findOneByOrFail({ serviceId, key: 'visitor' });
    expect(visitor.label).toBe('방문자');
    expect(visitor.description).toBe('서비스 신청이 필요함');

    await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceId}/permissions/${visitor.id}/deprecate`)
      .set('x-admin-key', 'test-admin-key')
      .expect(400);

    const seedVisitorCount = await dataSource
      .getRepository(AccountServicePermissionEntity)
      .countBy({
        serviceId,
        permissionDefinitionId: visitor.id,
        status: 'active',
      });
    expect(seedVisitorCount).toBeGreaterThanOrEqual(1);

    const accountResponse = await request(app.getHttpServer())
      .post('/api/admin/accounts')
      .set('x-admin-key', 'test-admin-key')
      .send({
        loginId: `user-${suffix}`,
        name: `User ${suffix}`,
        email: `user-${suffix}@lafamila.xyz`,
        password: 'test-password-1234',
      })
      .expect(201);

    const assigned = await dataSource
      .getRepository(AccountServicePermissionEntity)
      .findOneByOrFail({
        accountId: accountResponse.body.id as string,
        serviceId,
        permissionDefinitionId: visitor.id,
        status: 'active',
      });
    expect(assigned.permissionDefinitionId).toBe(visitor.id);

    const adminPermissionResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceId}/permissions`)
      .set('x-admin-key', 'test-admin-key')
      .send({
        key: `admin-${suffix}`,
        label: 'Admin',
        description: 'Elevated access',
      })
      .expect(201);

    const account = await dataSource
      .getRepository(AccountEntity)
      .findOneByOrFail({ id: accountResponse.body.id as string });
    const service = await dataSource
      .getRepository(ServiceEntity)
      .findOneByOrFail({ id: serviceId });
    const visitorAssignment = await dataSource
      .getRepository(AccountServicePermissionEntity)
      .findOneOrFail({
        where: {
          accountId: account.id,
          serviceId,
          status: 'active',
        },
        relations: { permissionDefinition: true },
      });
    const tokenService = app.get(TokenService);
    const tokens = tokenService.issueTokens(
      account,
      { clientId: `todo-web-${suffix}`, service } as OidcClientEntity,
      visitorAssignment,
    );

    const applicationResponse = await request(app.getHttpServer())
      .post('/api/service-applications')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        serviceKey: service.serviceKey,
        message: 'I need access for testing.',
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/admin/service-applications?status=pending')
      .set('x-admin-key', 'test-admin-key')
      .expect(200)
      .expect((response) => {
        const applications = response.body as Array<{ id: string }>;
        expect(
          applications.some((item) => item.id === applicationResponse.body.id),
        ).toBe(true);
      });

    await request(app.getHttpServer())
      .post(`/api/admin/service-applications/${applicationResponse.body.id}/approve`)
      .set('x-admin-key', 'test-admin-key')
      .send({
        targetPermissionDefinitionId: adminPermissionResponse.body.id,
      })
      .expect(201);

    const elevated = await dataSource
      .getRepository(AccountServicePermissionEntity)
      .findOneByOrFail({
        accountId: account.id,
        serviceId,
        status: 'active',
      });
    expect(elevated.permissionDefinitionId).toBe(adminPermissionResponse.body.id);
  });

  it('manages service credentials through the admin api without exposing stored secrets', async () => {
    const suffix = Date.now();
    const serviceResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('x-admin-key', 'test-admin-key')
      .send({
        serviceKey: `svc-cred-${suffix}`,
        name: `Service Credential ${suffix}`,
      })
      .expect(201);

    const createResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceResponse.body.id}/credentials`)
      .set('x-admin-key', 'test-admin-key')
      .send({
        name: 'todo-api local',
        description: 'account search integration',
        scopes: ['account.search', 'permission.read'],
        expiresAt: null,
      })
      .expect(201);

    expect(createResponse.body.keyId).toMatch(/^asc_/);
    expect(createResponse.body.secret).toBeTruthy();
    expect(createResponse.body.secretHash).toBeUndefined();

    const storedCredential = await dataSource
      .getRepository(ServiceCredentialEntity)
      .findOneByOrFail({ id: createResponse.body.id as string });
    expect(storedCredential.secretHash).toContain('$argon2');
    expect(storedCredential.secretHash).not.toBe(createResponse.body.secret);

    const listResponse = await request(app.getHttpServer())
      .get(`/api/admin/services/${serviceResponse.body.id}/credentials`)
      .set('x-admin-key', 'test-admin-key')
      .expect(200);

    expect(listResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createResponse.body.id,
          keyId: createResponse.body.keyId,
          serviceId: serviceResponse.body.id,
          scopes: ['account.search', 'permission.read'],
          status: 'active',
        }),
      ]),
    );
    expect(listResponse.body[0].secret).toBeUndefined();
    expect(listResponse.body[0].secretHash).toBeUndefined();

    await request(app.getHttpServer())
      .patch(
        `/api/admin/services/${serviceResponse.body.id}/credentials/${createResponse.body.id}`,
      )
      .set('x-admin-key', 'test-admin-key')
      .send({
        name: 'todo-api updated',
        description: 'updated account search integration',
        scopes: ['permission.read'],
        status: 'disabled',
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.name).toBe('todo-api updated');
        expect(response.body.description).toBe('updated account search integration');
        expect(response.body.scopes).toEqual(['permission.read']);
        expect(response.body.status).toBe('disabled');
        expect(response.body.secret).toBeUndefined();
        expect(response.body.secretHash).toBeUndefined();
      });

    const rotateResponse = await request(app.getHttpServer())
      .post(
        `/api/admin/services/${serviceResponse.body.id}/credentials/${createResponse.body.id}/rotate`,
      )
      .set('x-admin-key', 'test-admin-key')
      .send({})
      .expect(400);

    expect(rotateResponse.body.message).toBe('Disabled credentials cannot be rotated');

    await request(app.getHttpServer())
      .patch(
        `/api/admin/services/${serviceResponse.body.id}/credentials/${createResponse.body.id}`,
      )
      .set('x-admin-key', 'test-admin-key')
      .send({
        status: 'active',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(
        `/api/admin/services/${serviceResponse.body.id}/credentials/${createResponse.body.id}/rotate`,
      )
      .set('x-admin-key', 'test-admin-key')
      .send({})
      .expect(201)
      .expect((response) => {
        expect(response.body.keyId).toBe(createResponse.body.keyId);
        expect(response.body.secret).toBeTruthy();
        expect(response.body.secret).not.toBe(createResponse.body.secret);
      });
  });

  it('returns permission dashboard rows and keeps revoked assignments visible', async () => {
    const suffix = Date.now();
    const serviceResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('x-admin-key', 'test-admin-key')
      .send({
        serviceKey: `dashboard-${suffix}`,
        name: `Dashboard ${suffix}`,
      })
      .expect(201);

    const permissionResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceResponse.body.id}/permissions`)
      .set('x-admin-key', 'test-admin-key')
      .send({
        key: `manager-${suffix}`,
        label: 'Manager',
        description: 'Dashboard permission',
      })
      .expect(201);

    const accountResponse = await request(app.getHttpServer())
      .post('/api/admin/accounts')
      .set('x-admin-key', 'test-admin-key')
      .send({
        loginId: `dashboard-user-${suffix}`,
        name: `Dashboard User ${suffix}`,
        email: `dashboard-user-${suffix}@lafamila.xyz`,
        password: 'dashboard-password-1234',
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/admin/permission-dashboard')
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/admin/permission-dashboard')
      .set('x-admin-key', 'wrong-key')
      .expect(401);

    await request(app.getHttpServer())
      .put(
        `/api/admin/accounts/${accountResponse.body.id}/services/${serviceResponse.body.id}/permission`,
      )
      .set('x-admin-key', 'test-admin-key')
      .send({
        permissionDefinitionId: permissionResponse.body.id,
      })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/admin/permission-dashboard')
      .set('x-admin-key', 'test-admin-key')
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              accountId: accountResponse.body.id,
              loginId: accountResponse.body.loginId,
              accountName: accountResponse.body.name,
              email: accountResponse.body.email,
              accountStatus: 'active',
              isSuperAdmin: false,
              serviceId: serviceResponse.body.id,
              serviceKey: serviceResponse.body.serviceKey,
              serviceName: serviceResponse.body.name,
              serviceStatus: 'active',
              permissionDefinitionId: permissionResponse.body.id,
              permissionKey: permissionResponse.body.key,
              permissionLabel: permissionResponse.body.label,
              permissionStatus: 'active',
              assignmentStatus: 'active',
              revokedAt: null,
              grantedByAccountId: null,
            }),
          ]),
        );
      });

    await request(app.getHttpServer())
      .delete(
        `/api/admin/accounts/${accountResponse.body.id}/services/${serviceResponse.body.id}/permission`,
      )
      .set('x-admin-key', 'test-admin-key')
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/admin/permission-dashboard')
      .set('x-admin-key', 'test-admin-key')
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              accountId: accountResponse.body.id,
              serviceId: serviceResponse.body.id,
              permissionDefinitionId: permissionResponse.body.id,
              assignmentStatus: 'revoked',
            }),
          ]),
        );
        const dashboardRows = response.body as Array<{
          accountId: string;
          serviceId: string;
          revokedAt: string | null;
        }>;
        const dashboardRow = dashboardRows.find(
          (row: { accountId: string; serviceId: string }) =>
            row.accountId === accountResponse.body.id &&
            row.serviceId === serviceResponse.body.id,
        );
        if (!dashboardRow) {
          throw new Error('Dashboard row not found');
        }
        expect(dashboardRow.revokedAt).toBeTruthy();
      });
  });

  it('lists and updates oidc clients without exposing stored secret hashes', async () => {
    const suffix = Date.now();
    const serviceResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('x-admin-key', 'test-admin-key')
      .send({
        serviceKey: `oidc-${suffix}`,
        name: `OIDC ${suffix}`,
      })
      .expect(201);

    const createResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceResponse.body.id}/clients`)
      .set('x-admin-key', 'test-admin-key')
      .send({
        clientId: `oidc-client-${suffix}`,
        clientType: 'confidential',
        clientSecret: 'very-secret-client-value',
        redirectUris: ['http://127.0.0.1/callback'],
      })
      .expect(201);

    expect(createResponse.body.clientSecretHash).toBeUndefined();

    await request(app.getHttpServer())
      .get(`/api/admin/services/${serviceResponse.body.id}/clients`)
      .set('x-admin-key', 'test-admin-key')
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: createResponse.body.id,
              clientId: `oidc-client-${suffix}`,
              clientType: 'confidential',
              redirectUris: ['http://127.0.0.1/callback'],
              status: 'active',
            }),
          ]),
        );
        expect(response.body[0].clientSecretHash).toBeUndefined();
      });

    await request(app.getHttpServer())
      .patch(`/api/admin/services/${serviceResponse.body.id}/clients/${createResponse.body.id}`)
      .set('x-admin-key', 'test-admin-key')
      .send({
        status: 'disabled',
        redirectUris: ['http://127.0.0.1/updated-callback'],
        postLogoutRedirectUris: ['http://127.0.0.1/logout'],
        allowedGrantTypes: ['authorization_code'],
        allowedScopes: ['openid', 'profile'],
        requirePkce: false,
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.clientSecretHash).toBeUndefined();
        expect(response.body.status).toBe('disabled');
        expect(response.body.redirectUris).toEqual([
          'http://127.0.0.1/updated-callback',
        ]);
        expect(response.body.postLogoutRedirectUris).toEqual([
          'http://127.0.0.1/logout',
        ]);
        expect(response.body.allowedGrantTypes).toEqual(['authorization_code']);
        expect(response.body.allowedScopes).toEqual(['openid', 'profile']);
        expect(response.body.requirePkce).toBe(false);
      });
  });

  it('protects internal account search with scoped service credentials', async () => {
    const suffix = Date.now();
    const todoServiceResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('x-admin-key', 'test-admin-key')
      .send({
        serviceKey: `todo-${suffix}`,
        name: `Todo ${suffix}`,
      })
      .expect(201);
    const otherServiceResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('x-admin-key', 'test-admin-key')
      .send({
        serviceKey: `other-${suffix}`,
        name: `Other ${suffix}`,
      })
      .expect(201);

    const accountResponse = await request(app.getHttpServer())
      .post('/api/admin/accounts')
      .set('x-admin-key', 'test-admin-key')
      .send({
        loginId: `lookup-${suffix}`,
        name: `Lookup ${suffix}`,
        email: `lookup-${suffix}@lafamila.xyz`,
        password: 'lookup-password-1234',
      })
      .expect(201);

    const searchCredentialResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${todoServiceResponse.body.id}/credentials`)
      .set('x-admin-key', 'test-admin-key')
      .send({
        name: 'search credential',
        scopes: ['account.search'],
      })
      .expect(201);

    const wrongScopeCredentialResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${todoServiceResponse.body.id}/credentials`)
      .set('x-admin-key', 'test-admin-key')
      .send({
        name: 'wrong scope credential',
        scopes: ['permission.read'],
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .query({ serviceKey: todoServiceResponse.body.serviceKey, q: 'lookup' })
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-admin-key', 'test-admin-key')
      .query({ serviceKey: todoServiceResponse.body.serviceKey, q: 'lookup' })
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchCredentialResponse.body.keyId)
      .set('x-auth-service-secret', 'wrong-secret')
      .query({ serviceKey: todoServiceResponse.body.serviceKey, q: 'lookup' })
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', wrongScopeCredentialResponse.body.keyId)
      .set('x-auth-service-secret', wrongScopeCredentialResponse.body.secret)
      .query({ serviceKey: todoServiceResponse.body.serviceKey, q: 'lookup' })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchCredentialResponse.body.keyId)
      .set('x-auth-service-secret', searchCredentialResponse.body.secret)
      .query({ serviceKey: otherServiceResponse.body.serviceKey, q: 'lookup' })
      .expect(403);

    const validSearchResponse = await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchCredentialResponse.body.keyId)
      .set('x-auth-service-secret', searchCredentialResponse.body.secret)
      .query({ serviceKey: todoServiceResponse.body.serviceKey, q: 'lookup' })
      .expect(200);

    expect(validSearchResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: accountResponse.body.id,
          loginId: accountResponse.body.loginId,
          name: accountResponse.body.name,
          email: accountResponse.body.email,
          status: 'active',
          isSuperAdmin: false,
          permissionKey: 'visitor',
        }),
      ]),
    );

    const usedCredential = await dataSource
      .getRepository(ServiceCredentialEntity)
      .findOneByOrFail({ id: searchCredentialResponse.body.id as string });
    expect(usedCredential.lastUsedAt).not.toBeNull();
    expect(usedCredential.lastUsedFrom).toBeTruthy();

    await request(app.getHttpServer())
      .post(
        `/api/admin/services/${todoServiceResponse.body.id}/credentials/${searchCredentialResponse.body.id}/disable`,
      )
      .set('x-admin-key', 'test-admin-key')
      .send({})
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/internal/service-accounts/search')
      .set('x-auth-service-key-id', searchCredentialResponse.body.keyId)
      .set('x-auth-service-secret', searchCredentialResponse.body.secret)
      .query({ serviceKey: todoServiceResponse.body.serviceKey, q: 'lookup' })
      .expect(401);
  });
});
