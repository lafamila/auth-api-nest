import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AccountServicePermissionEntity } from '../src/database/entities/account-service-permission.entity';
import { AccountEntity } from '../src/database/entities/account.entity';
import { OidcClientEntity } from '../src/database/entities/oidc-client.entity';
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
});
