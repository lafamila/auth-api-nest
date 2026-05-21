import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('App bootstrap (e2e)', () => {
  let app: INestApplication;

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
});
