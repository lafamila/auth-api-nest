// Isolated browser fixture. Never loaded by the production application.
require('ts-node').register({ files: true });
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const cookieParser = require('cookie-parser');
const { createHash, randomUUID } = require('node:crypto');
const http = require('node:http');
const { DataSource } = require('typeorm');
const { AppModule } = require('../src/app.module');
const { ServiceEntity } = require('../src/database/entities/service.entity');
const {
  OidcClientEntity,
} = require('../src/database/entities/oidc-client.entity');
const {
  ServicePermissionDefinitionEntity,
} = require('../src/database/entities/service-permission-definition.entity');
const {
  SocialProvidersService,
} = require('../src/social/social-providers.service');
const {
  EmailDeliveryService,
} = require('../src/signup/email-delivery.service');

const databaseUrl = process.env.SOCIAL_BROWSER_DATABASE_URL;
const parsedDatabaseUrl = databaseUrl ? new URL(databaseUrl) : null;
if (
  !parsedDatabaseUrl ||
  !['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol) ||
  !decodeURIComponent(parsedDatabaseUrl.pathname).startsWith(
    '/auth_social_browser',
  ) ||
  decodeURIComponent(parsedDatabaseUrl.pathname).slice(1).includes('/') ||
  [...parsedDatabaseUrl.searchParams.keys()].some((key) =>
    ['database', 'dbname'].includes(key.toLowerCase()),
  )
) {
  throw new Error(
    'Set SOCIAL_BROWSER_DATABASE_URL to an isolated auth_social_browser* database',
  );
}
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  RUN_MIGRATIONS: 'false',
  NOTIFICATIONS_ENABLED: 'false',
  PERMISSION_WEBHOOKS_ENABLED: 'false',
  COOKIE_SECRET: 'isolated-browser-fixture-cookie',
});
for (const provider of ['google', 'kakao', 'naver']) {
  process.env[`SOCIAL_${provider.toUpperCase()}_CLIENT_ID`] =
    `fixture-${provider}`;
  process.env[`SOCIAL_${provider.toUpperCase()}_CLIENT_SECRET`] =
    'fixture-not-a-real-secret';
}

(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  const server = app.getHttpAdapter().getInstance();
  const profiles = new Map();
  const originalAuthorization = app
    .get(SocialProvidersService)
    .authorizationUrl.bind(app.get(SocialProvidersService));
  app.get(SocialProvidersService).authorizationUrl = (provider, input) => {
    const original = new URL(originalAuthorization(provider, input));
    const fake = new URL(
      '/fixture/provider',
      process.env.ISSUER_URL.replace('127.0.0.1', 'localhost'),
    );
    fake.searchParams.set('provider', provider);
    fake.searchParams.set('state', input.state);
    fake.searchParams.set(
      'callback',
      original.searchParams.get('redirect_uri'),
    );
    profiles.set(input.state, {
      provider,
      providerClientId: `fixture-${provider}`,
      subject: randomUUID(),
      email: `${provider}-${input.state.slice(0, 8)}@gmail.com`,
      emailVerified: provider !== 'naver',
      name: 'Browser Test',
    });
    return fake.toString();
  };
  app.get(SocialProvidersService).exchangeCode = async (_provider, input) =>
    profiles.get(input.state);
  let lastCode;
  app.get(EmailDeliveryService).sendSignupCode = async (_email, code) => {
    lastCode = code;
  };
  server.get('/fixture/provider', (req, res) => {
    const url = new URL(req.query.callback);
    url.searchParams.set('state', req.query.state);
    url.searchParams.set('code', 'fixture-authorization-code');
    res.redirect(url.toString());
  });
  server.get('/fixture/last-code', (_req, res) => res.json({ code: lastCode }));
  let callbackUri;
  let clientId;
  const verifier = 'browser-fixture-'.repeat(4);
  server.get('/fixture/login', (_req, res) => {
    const url = new URL('/oauth/authorize', process.env.ISSUER_URL);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUri,
      response_type: 'code',
      scope: 'openid profile email service.permission',
      state: 'fixture-state',
      nonce: 'fixture-nonce',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    res.redirect(url.toString());
  });
  const clientServer = http.createServer(async (req, res) => {
    if (req.url.startsWith('/callback')) {
      try {
        const url = new URL(req.url, callbackUri);
        if (url.searchParams.get('state') !== 'fixture-state')
          throw new Error('Invalid state');
        const result = await fetch(`${process.env.ISSUER_URL}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: clientId,
            redirect_uri: callbackUri,
            code: url.searchParams.get('code'),
            code_verifier: verifier,
          }),
        });
        if (!result.ok) throw new Error('Code exchange failed');
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie':
            'fixture_service_session=authenticated; Path=/; HttpOnly; SameSite=Lax',
        });
        res.end();
      } catch (error) {
        res.writeHead(500);
        res.end(error.message);
      }
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<h1>Service home</h1>');
    }
  });
  await new Promise((resolve) => clientServer.listen(0, '127.0.0.1', resolve));
  callbackUri = `http://127.0.0.1:${clientServer.address().port}/callback`;
  await app.init();
  await app.listen(0, '127.0.0.1');
  process.env.ISSUER_URL = await app.getUrl();
  const db = app.get(DataSource);
  const service = await db.getRepository(ServiceEntity).save({
    serviceKey: `browser-${randomUUID()}`,
    name: 'Browser fixture',
    status: 'active',
  });
  await db.getRepository(ServicePermissionDefinitionEntity).save({
    serviceId: service.id,
    key: 'visitor',
    label: 'Visitor',
    status: 'active',
  });
  clientId = `browser-${randomUUID()}`;
  await db.getRepository(OidcClientEntity).save({
    serviceId: service.id,
    clientId,
    clientType: 'public',
    redirectUris: [callbackUri],
    allowedGrantTypes: ['authorization_code', 'refresh_token'],
    allowedScopes: ['openid', 'profile', 'email', 'service.permission'],
    requirePkce: true,
    status: 'active',
  });
  console.log(
    JSON.stringify({
      login: `${process.env.ISSUER_URL}/fixture/login`,
      lastCode: `${process.env.ISSUER_URL}/fixture/last-code`,
      callback: callbackUri,
    }),
  );
  const close = async () => {
    clientServer.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
