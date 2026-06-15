import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AccountServicePermissionEntity } from '../src/database/entities/account-service-permission.entity';
import { AccountEntity } from '../src/database/entities/account.entity';
import { OidcClientEntity } from '../src/database/entities/oidc-client.entity';
import { ServiceCredentialEntity } from '../src/database/entities/service-credential.entity';
import { ServicePermissionDefinitionEntity } from '../src/database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../src/database/entities/service.entity';
import { AdminMfaEntity } from '../src/database/entities/admin-mfa.entity';
import { AesGcmService } from '../src/common/crypto/aes-gcm.service';
import { TotpService } from '../src/common/crypto/totp.service';
import { AccountsService } from '../src/domain/accounts/accounts.service';
import { TokenService } from '../src/oidc/token.service';

interface PermissionDashboardTestRow {
  accountId: string;
  serviceId: string;
  serviceKey: string;
}

interface PermissionDashboardTestPage {
  items: PermissionDashboardTestRow[];
}

describe('App bootstrap (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminCookie: string[];

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL =
      process.env.TEST_DATABASE_URL ??
      'postgres://postgres:postgres@localhost:35432/teddy_auth';
    process.env.COOKIE_SECRET = 'test-cookie-secret';
    process.env.SEED_ADMIN_LOGIN_ID = 'superadmin-test';
    process.env.SEED_ADMIN_PASSWORD = 'superadmin-password';
    process.env.SEED_ADMIN_EMAIL = 'superadmin-test@lafamila.xyz';

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

  async function createAdminSessionCookie(): Promise<string[]> {
    const suffix = Date.now();
    const loginId = `superadmin-e2e-${suffix}`;
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
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
      .expect(200)
      .expect((response) => {
        const applications = response.body as Array<{ id: string }>;
        expect(
          applications.some((item) => item.id === applicationResponse.body.id),
        ).toBe(true);
      });

    await request(app.getHttpServer())
      .post(`/api/admin/service-applications/${applicationResponse.body.id}/approve`)
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
      .send({
        serviceKey: `svc-cred-${suffix}`,
        name: `Service Credential ${suffix}`,
      })
      .expect(201);

    const createResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceResponse.body.id}/credentials`)
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
      .send({})
      .expect(400);

    expect(rotateResponse.body.message).toBe('Disabled credentials cannot be rotated');

    await request(app.getHttpServer())
      .patch(
        `/api/admin/services/${serviceResponse.body.id}/credentials/${createResponse.body.id}`,
      )
      .set('Cookie', adminCookie)
      .send({
        status: 'active',
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(
        `/api/admin/services/${serviceResponse.body.id}/credentials/${createResponse.body.id}/rotate`,
      )
      .set('Cookie', adminCookie)
      .send({})
      .expect(201)
      .expect((response) => {
        expect(response.body.keyId).toBe(createResponse.body.keyId);
        expect(response.body.secret).toBeTruthy();
        expect(response.body.secret).not.toBe(createResponse.body.secret);
      });
  });

  it('returns paginated active-only permission dashboard rows', async () => {
    const suffix = Date.now();
    const serviceResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('Cookie', adminCookie)
      .send({
        serviceKey: `dashboard-${suffix}`,
        name: `Dashboard ${suffix}`,
      })
      .expect(201);
    const otherServiceResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('Cookie', adminCookie)
      .send({
        serviceKey: `dashboard-other-${suffix}`,
        name: `Dashboard Other ${suffix}`,
      })
      .expect(201);

    const permissionResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceResponse.body.id}/permissions`)
      .set('Cookie', adminCookie)
      .send({
        key: `manager-${suffix}`,
        label: 'Manager',
        description: 'Dashboard permission',
      })
      .expect(201);
    const otherPermissionResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${otherServiceResponse.body.id}/permissions`)
      .set('Cookie', adminCookie)
      .send({
        key: `manager-${suffix}`,
        label: 'Manager',
        description: 'Dashboard permission',
      })
      .expect(201);

    const accountResponse = await request(app.getHttpServer())
      .post('/api/admin/accounts')
      .set('Cookie', adminCookie)
      .send({
        loginId: `dashboard-user-${suffix}`,
        name: `Dashboard User ${suffix}`,
        email: `dashboard-user-${suffix}@lafamila.xyz`,
        password: 'dashboard-password-1234',
      })
      .expect(201);
    const otherAccountResponse = await request(app.getHttpServer())
      .post('/api/admin/accounts')
      .set('Cookie', adminCookie)
      .send({
        loginId: `dashboard-other-user-${suffix}`,
        name: `Dashboard Other User ${suffix}`,
        email: `dashboard-other-user-${suffix}@lafamila.xyz`,
        password: 'dashboard-password-1234',
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/admin/permission-dashboard')
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/admin/permission-dashboard')
      .set('Cookie', ['tas_admin_session=s:invalid-signature'])
      .expect(401);

    await request(app.getHttpServer())
      .put(
        `/api/admin/accounts/${accountResponse.body.id}/services/${serviceResponse.body.id}/permission`,
      )
      .set('Cookie', adminCookie)
      .send({
        permissionDefinitionId: permissionResponse.body.id,
      })
      .expect(200);
    await request(app.getHttpServer())
      .put(
        `/api/admin/accounts/${otherAccountResponse.body.id}/services/${otherServiceResponse.body.id}/permission`,
      )
      .set('Cookie', adminCookie)
      .send({
        permissionDefinitionId: otherPermissionResponse.body.id,
      })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/admin/permission-dashboard?page=1&pageSize=1')
      .set('Cookie', adminCookie)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.objectContaining({
            items: expect.any(Array),
            page: 1,
            pageSize: 1,
            total: expect.any(Number),
            totalPages: expect.any(Number),
          }),
        );
        expect(response.body.items).toHaveLength(1);
        expect(response.body.items[0].accountStatus).toBeUndefined();
        expect(response.body.items[0].serviceStatus).toBeUndefined();
        expect(response.body.items[0].assignmentStatus).toBeUndefined();
        expect(response.body.items[0].revokedAt).toBeUndefined();
      });

    await request(app.getHttpServer())
      .get('/api/admin/permission-dashboard')
      .query({ serviceKey: serviceResponse.body.serviceKey, page: 1, pageSize: 25 })
      .set('Cookie', adminCookie)
      .expect(200)
      .expect((response) => {
        expect(response.body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              accountId: accountResponse.body.id,
              loginId: accountResponse.body.loginId,
              accountName: accountResponse.body.name,
              email: accountResponse.body.email,
              serviceId: serviceResponse.body.id,
              serviceKey: serviceResponse.body.serviceKey,
              serviceName: serviceResponse.body.name,
              permissionDefinitionId: permissionResponse.body.id,
              permissionKey: permissionResponse.body.key,
              permissionLabel: permissionResponse.body.label,
              permissionStatus: 'active',
              grantedByAccountId: null,
            }),
          ]),
        );
        const dashboard = response.body as PermissionDashboardTestPage;
        expect(
          dashboard.items.some(
            (row: { serviceKey: string }) =>
              row.serviceKey === otherServiceResponse.body.serviceKey,
          ),
        ).toBe(false);
      });

    await request(app.getHttpServer())
      .delete(
        `/api/admin/accounts/${accountResponse.body.id}/services/${serviceResponse.body.id}/permission`,
      )
      .set('Cookie', adminCookie)
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/admin/permission-dashboard')
      .query({ serviceKey: serviceResponse.body.serviceKey })
      .set('Cookie', adminCookie)
      .expect(200)
      .expect((response) => {
        const dashboard = response.body as PermissionDashboardTestPage;
        expect(
          dashboard.items.some(
            (row: { accountId: string; serviceId: string }) =>
              row.accountId === accountResponse.body.id &&
              row.serviceId === serviceResponse.body.id,
          ),
        ).toBe(false);
      });

    await request(app.getHttpServer())
      .put(
        `/api/admin/accounts/${accountResponse.body.id}/services/${serviceResponse.body.id}/permission`,
      )
      .set('Cookie', adminCookie)
      .send({
        permissionDefinitionId: permissionResponse.body.id,
      })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/admin/accounts/${accountResponse.body.id}`)
      .set('Cookie', adminCookie)
      .send({ status: 'disabled' })
      .expect(200)
      .expect((response) => {
        expect(response.body.status).toBe('disabled');
      });

    await request(app.getHttpServer())
      .get('/api/admin/permission-dashboard')
      .query({ serviceKey: serviceResponse.body.serviceKey })
      .set('Cookie', adminCookie)
      .expect(200)
      .expect((response) => {
        const dashboard = response.body as PermissionDashboardTestPage;
        expect(
          dashboard.items.some(
            (row: { accountId: string; serviceId: string }) =>
              row.accountId === accountResponse.body.id &&
              row.serviceId === serviceResponse.body.id,
          ),
        ).toBe(false);
      });

    const retainedAssignment = await dataSource
      .getRepository(AccountServicePermissionEntity)
      .findOneByOrFail({
        accountId: accountResponse.body.id as string,
        serviceId: serviceResponse.body.id as string,
      });
    expect(retainedAssignment.status).toBe('active');

    await request(app.getHttpServer())
      .post('/login')
      .send({
        loginId: accountResponse.body.loginId,
        password: 'dashboard-password-1234',
      })
      .expect(401);
  });

  it('lists and updates oidc clients without exposing stored secret hashes', async () => {
    const suffix = Date.now();
    const serviceResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('Cookie', adminCookie)
      .send({
        serviceKey: `oidc-${suffix}`,
        name: `OIDC ${suffix}`,
      })
      .expect(201);

    const createResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${serviceResponse.body.id}/clients`)
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
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

  it('onboards body-lab public native clients and completes PKCE without client secrets', async () => {
    const serviceRepository = dataSource.getRepository(ServiceEntity);
    const permissionRepository = dataSource.getRepository(
      ServicePermissionDefinitionEntity,
    );
    const clientRepository = dataSource.getRepository(OidcClientEntity);

    const serviceCreateResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('Cookie', adminCookie)
      .send({
        serviceKey: 'body-lab',
        name: 'body-lab',
        description: 'Diet body research service',
      });
    expect([201, 409]).toContain(serviceCreateResponse.status);

    let service = await serviceRepository.findOneByOrFail({ serviceKey: 'body-lab' });
    if (service.status !== 'active') {
      await request(app.getHttpServer())
        .patch(`/api/admin/services/${service.id}`)
        .set('Cookie', adminCookie)
        .send({ status: 'active' })
        .expect(200);
      service = await serviceRepository.findOneByOrFail({ serviceKey: 'body-lab' });
    }

    const ownerCreateResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${service.id}/permissions`)
      .set('Cookie', adminCookie)
      .send({
        key: 'owner',
        label: 'Owner',
        description: 'Full body-lab access',
      });
    expect([201, 409]).toContain(ownerCreateResponse.status);

    let ownerPermission = await permissionRepository.findOneByOrFail({
      serviceId: service.id,
      key: 'owner',
    });
    if (ownerPermission.status !== 'active') {
      await request(app.getHttpServer())
        .patch(`/api/admin/services/${service.id}/permissions/${ownerPermission.id}`)
        .set('Cookie', adminCookie)
        .send({ status: 'active' })
        .expect(200);
      ownerPermission = await permissionRepository.findOneByOrFail({
        serviceId: service.id,
        key: 'owner',
      });
    }
    service = await serviceRepository.findOneByOrFail({ serviceKey: 'body-lab' });

    for (const client of [
      {
        clientId: 'body-lab-ios',
        redirectUris: ['bodylab://auth/callback'],
      },
      {
        clientId: 'body-lab-mac',
        redirectUris: ['bodylab-mac://auth/callback'],
      },
    ]) {
      const existingClient = await clientRepository.findOneBy({
        clientId: client.clientId,
      });
      if (existingClient) {
        await request(app.getHttpServer())
          .patch(`/api/admin/services/${service.id}/clients/${existingClient.id}`)
          .set('Cookie', adminCookie)
          .send({
            clientType: 'public',
            status: 'active',
            redirectUris: client.redirectUris,
            allowedGrantTypes: ['authorization_code', 'refresh_token'],
            allowedScopes: ['openid', 'profile', 'email', 'service.permission'],
            requirePkce: true,
          })
          .expect(200);
      } else {
        await request(app.getHttpServer())
          .post(`/api/admin/services/${service.id}/clients`)
          .set('Cookie', adminCookie)
          .send({
            ...client,
            clientType: 'public',
            allowedGrantTypes: ['authorization_code', 'refresh_token'],
            allowedScopes: ['openid', 'profile', 'email', 'service.permission'],
            requirePkce: true,
          })
          .expect(201);
      }

      const storedClient = await clientRepository.findOneByOrFail({
        clientId: client.clientId,
      });
      expect(storedClient.clientSecretHash).toBeNull();
      expect(storedClient.clientType).toBe('public');
      expect(storedClient.redirectUris).toEqual(client.redirectUris);
      expect(storedClient.requirePkce).toBe(true);
    }

    const suffix = Date.now();
    const accountPassword = 'body-lab-password-1234';
    const accountResponse = await request(app.getHttpServer())
      .post('/api/admin/accounts')
      .set('Cookie', adminCookie)
      .send({
        loginId: `body-lab-owner-${suffix}`,
        name: `Body Lab Owner ${suffix}`,
        email: `body-lab-owner-${suffix}@lafamila.xyz`,
        password: accountPassword,
      })
      .expect(201);

    await request(app.getHttpServer())
      .put(
        `/api/admin/accounts/${accountResponse.body.id}/services/${service.id}/permission`,
      )
      .set('Cookie', adminCookie)
      .send({
        permissionDefinitionId: ownerPermission.id,
      })
      .expect(200);

    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/login')
      .send({
        loginId: accountResponse.body.loginId,
        password: accountPassword,
      })
      .expect(201);

    const codeVerifier = `verifier-${suffix}-body-lab-native-pkce`;
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const authorizeResponse = await agent
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: 'body-lab-ios',
        redirect_uri: 'bodylab://auth/callback',
        scope: 'openid profile email service.permission',
        state: 'body-lab-state',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      })
      .expect(302);

    const redirect = new URL(authorizeResponse.headers.location);
    expect(`${redirect.protocol}//${redirect.host}${redirect.pathname}`).toBe(
      'bodylab://auth/callback',
    );
    expect(redirect.searchParams.get('state')).toBe('body-lab-state');
    const code = redirect.searchParams.get('code');
    expect(code).toBeTruthy();

    await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        client_id: 'body-lab-ios',
        redirect_uri: 'bodylab://auth/callback',
        code,
        code_verifier: codeVerifier,
      })
      .expect(200)
      .expect((response) => {
        const tokenService = app.get(TokenService);
        const payload = tokenService.verifyAccessToken(response.body.access_token);
        expect(payload.aud).toBe('service:body-lab');
        expect(payload.scope).toBe('openid profile email service.permission');
        expect(payload['https://lafamila.xyz/claims/service']).toEqual({
          key: 'body-lab',
          permission: 'owner',
          permissionSchemaVersion: service.permissionSchemaVersion,
        });
      });
  });

  it('protects internal account search with scoped service credentials', async () => {
    const suffix = Date.now();
    const todoServiceResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('Cookie', adminCookie)
      .send({
        serviceKey: `todo-${suffix}`,
        name: `Todo ${suffix}`,
      })
      .expect(201);
    const otherServiceResponse = await request(app.getHttpServer())
      .post('/api/admin/services')
      .set('Cookie', adminCookie)
      .send({
        serviceKey: `other-${suffix}`,
        name: `Other ${suffix}`,
      })
      .expect(201);

    const accountResponse = await request(app.getHttpServer())
      .post('/api/admin/accounts')
      .set('Cookie', adminCookie)
      .send({
        loginId: `lookup-${suffix}`,
        name: `Lookup ${suffix}`,
        email: `lookup-${suffix}@lafamila.xyz`,
        password: 'lookup-password-1234',
      })
      .expect(201);

    const searchCredentialResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${todoServiceResponse.body.id}/credentials`)
      .set('Cookie', adminCookie)
      .send({
        name: 'search credential',
        scopes: ['account.search'],
      })
      .expect(201);

    const wrongScopeCredentialResponse = await request(app.getHttpServer())
      .post(`/api/admin/services/${todoServiceResponse.body.id}/credentials`)
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
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
      .set('Cookie', adminCookie)
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
