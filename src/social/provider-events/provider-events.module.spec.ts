import {
  INestApplication,
  Module,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppConfigService } from '../../config/app-config.service';
import { AccountLifecycleModule } from '../../portal/account-lifecycle.module';
import { GoogleEventsVerifier } from './google-events.verifier';
import { ProviderEventsModule } from './provider-events.module';
import { ProviderEventsService } from './provider-events.service';

@Module({})
class NoLifecycleModule {}

describe('ProviderEventsModule HTTP protocol boundaries (no DB/provider APIs)', () => {
  let app: INestApplication;
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const epoch = 1794960030;
  beforeAll(async () => {
    const env = new ConfigService({
      NODE_ENV: 'test',
      SOCIAL_NAVER_CLIENT_ID: 'naver-test-client',
      SOCIAL_NAVER_CLIENT_SECRET: 'naver-test-client-secret',
      SOCIAL_KAKAO_CLIENT_ID: 'kakao-test-client',
      SOCIAL_KAKAO_APP_ID: '123456',
      SOCIAL_KAKAO_ADMIN_KEY: 'test-admin',
      SOCIAL_GOOGLE_EVENTS_ENABLED: 'true',
      SOCIAL_GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
      SOCIAL_GOOGLE_CLIENT_SECRET: 'test-secret',
    });
    const module = await Test.createTestingModule({
      imports: [ProviderEventsModule],
    })
      .overrideModule(AccountLifecycleModule)
      .useModule(NoLifecycleModule)
      .overrideProvider(ProviderEventsService)
      .useValue({ enqueue })
      .overrideProvider(AppConfigService)
      .useValue(new AppConfigService(env))
      .overrideProvider(ConfigService)
      .useValue(env)
      .compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => {
    enqueue.mockClear();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
  });

  const kakaoForm = {
    app_id: '123456',
    user_id: '9007199254740993',
    referrer_type: 'UNLINK_FROM_APPS',
  };

  it('accepts Kakao GET and form POST, returning 200 after enqueuing', async () => {
    await request(app.getHttpServer())
      .get('/oauth/events/kakao')
      .query(kakaoForm)
      .set('Authorization', 'KakaoAK test-admin')
      .expect(200);
    await request(app.getHttpServer())
      .post('/oauth/events/kakao')
      .type('form')
      .send(kakaoForm)
      .set('Authorization', 'KakaoAK test-admin')
      .expect(200);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0][0].targets[0].subject).toBe(
      '9007199254740993',
    );
  });

  it('rejects JSON Kakao POST, duplicate query fields, and forged credentials', async () => {
    await request(app.getHttpServer())
      .post('/oauth/events/kakao')
      .send(kakaoForm)
      .set('Authorization', 'KakaoAK test-admin')
      .expect(415);
    await request(app.getHttpServer())
      .get(
        '/oauth/events/kakao?app_id=123456&user_id=1&user_id=2&referrer_type=UNLINK_FROM_APPS',
      )
      .set('Authorization', 'KakaoAK test-admin')
      .expect(400);
    await request(app.getHttpServer())
      .get('/oauth/events/kakao')
      .query(kakaoForm)
      .set('Authorization', 'KakaoAK forged')
      .expect(403);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('requires a Naver form, verifies the fixed vector, and returns empty 204', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(epoch * 1000);
    const form = {
      clientId: 'naver-test-client',
      encryptUniqueId:
        'AAECAwQFBgcICQoLDA0OD-pyo_MysNITfq9dkdcDKGMXV4Y89fXpP_aCJKn2qbd2',
      timestamp: '1794960000',
      signature: 'tmtau7HYgPmicWsR2BYcabllES8yIEzcELv1d4ac-ug',
    };
    const response = await request(app.getHttpServer())
      .post('/oauth/events/naver')
      .type('form')
      .send(form)
      .expect(204);
    expect(response.text).toBe('');
    await request(app.getHttpServer())
      .post('/oauth/events/naver')
      .send(form)
      .expect(415);
    await request(app.getHttpServer())
      .post('/oauth/events/naver')
      .type('form')
      .send({ ...form, signature: 'A'.repeat(43) })
      .expect(403);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('parses application/secevent+jwt through module middleware without a main.ts parser', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(epoch * 1000);
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = {
      ...pair.publicKey.export({ format: 'jwk' }),
      alg: 'RS256',
      use: 'sig',
      kid: 'http-test-key',
    };
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ keys: [key] })));
    const value = jwt.sign(
      {
        iss: 'https://accounts.google.com',
        aud: 'test-client.apps.googleusercontent.com',
        iat: epoch,
        jti: 'http-event-id',
        events: {
          'https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked':
            {
              subject: {
                subject_type: 'iss-sub',
                iss: 'https://accounts.google.com',
                sub: 'stable-subject',
              },
            },
        },
      },
      pair.privateKey,
      {
        algorithm: 'RS256',
        header: { alg: 'RS256', kid: 'http-test-key', typ: 'secevent+jwt' },
      },
    );
    await request(app.getHttpServer())
      .post('/oauth/events/google')
      .set('Content-Type', 'application/secevent+jwt')
      .send(value)
      .expect(202);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        targets: [
          {
            clientId: 'test-client.apps.googleusercontent.com',
            subject: 'stable-subject',
            kind: 'sessions_revoked',
          },
        ],
      }),
    );
    await request(app.getHttpServer())
      .post('/oauth/events/google')
      .set('Content-Type', 'text/plain')
      .send(value)
      .expect(415);
    await request(app.getHttpServer())
      .post('/oauth/events/google')
      .send({ jwt: value })
      .expect(415);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('uses the SET error envelope and language header for malformed Google tokens', async () => {
    const response = await request(app.getHttpServer())
      .post('/oauth/events/google')
      .set('Content-Type', 'application/secevent+jwt')
      .send('invalid.jwt.token')
      .expect(400);
    expect(response.headers['content-language']).toBe('en');
    expect(response.body).toEqual({
      err: 'invalid_request',
      description: 'Security event validation failed',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('maps Google authentication failures to SET HTTP 400 without exposing exception data', async () => {
    jest
      .spyOn(GoogleEventsVerifier.prototype, 'verify')
      .mockRejectedValueOnce(
        new UnauthorizedException('private-subject@example.test'),
      );
    const response = await request(app.getHttpServer())
      .post('/oauth/events/google')
      .set('Content-Type', 'application/secevent+jwt')
      .send('any-token')
      .expect(400);
    expect(response.body).toEqual({
      err: 'authentication_failed',
      description: 'Security event validation failed',
    });
    expect(JSON.stringify(response.body)).not.toContain('private-subject');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('preserves Google infrastructure failure as retryable 503', async () => {
    jest
      .spyOn(GoogleEventsVerifier.prototype, 'verify')
      .mockRejectedValueOnce(new ServiceUnavailableException());
    await request(app.getHttpServer())
      .post('/oauth/events/google')
      .set('Content-Type', 'application/secevent+jwt')
      .send('any-token')
      .expect(503);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not ACK when persistence fails', async () => {
    enqueue.mockRejectedValueOnce(new Error('unavailable'));
    app.useLogger(false);
    await request(app.getHttpServer())
      .get('/oauth/events/kakao')
      .query(kakaoForm)
      .set('Authorization', 'KakaoAK test-admin')
      .expect(500);
  });
});
