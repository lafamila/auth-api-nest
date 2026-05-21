import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppConfigService } from '../src/config/app-config.service';
import { OidcController } from '../src/oidc/oidc.controller';
import { SigningKeyService } from '../src/oidc/signing-key.service';

describe('OIDC discovery (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OidcController],
      providers: [
        SigningKeyService,
        { provide: AppConfigService, useValue: { issuerUrl: 'http://localhost:3032' } },
        { provide: 'AccountsService', useValue: {} },
      ],
    })
      .useMocker((token) => {
        if (typeof token === 'function') {
          return {};
        }
        return {};
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes discovery metadata and JWKS', async () => {
    await request(app.getHttpServer())
      .get('/.well-known/openid-configuration')
      .expect(200)
      .expect((response) => {
        expect(response.body.issuer).toBe('http://localhost:3032');
        expect(response.body.code_challenge_methods_supported).toContain('S256');
      });

    await request(app.getHttpServer())
      .get('/oauth/jwks')
      .expect(200)
      .expect((response) => {
        expect(response.body.keys[0].alg).toBe('RS256');
      });
  });
});
