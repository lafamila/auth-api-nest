import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AppConfigService } from '../../config/app-config.service';
import {
  GOOGLE_EVENT_KINDS,
  GOOGLE_RISC_ISSUER,
  GOOGLE_RISC_JWKS,
  GoogleEventsVerifier,
} from './google-events.verifier';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'test-key',
  kty: 'RSA',
  alg: 'RS256',
  use: 'sig',
};
const clientId = 'test-client.apps.googleusercontent.com';
const eventType =
  'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked';
const subject = {
  subject_type: 'iss-sub',
  iss: 'https://accounts.google.com/',
  sub: 'stable-google-subject',
  email: 'unused@example.test',
};
const now = 1794960030;

function token(
  overrides: Record<string, unknown> = {},
  header: Record<string, string | undefined> = {},
) {
  return jwt.sign(
    {
      iss: GOOGLE_RISC_ISSUER,
      aud: clientId,
      iat: now,
      jti: 'unique-event-id',
      events: { [eventType]: { subject } },
      ...overrides,
    },
    pair.privateKey,
    {
      algorithm: 'RS256',
      header: { alg: 'RS256', kid: 'test-key', typ: 'secevent+jwt', ...header },
    },
  );
}

describe('GoogleEventsVerifier', () => {
  let verifier: GoogleEventsVerifier;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now * 1000);
    const env = new ConfigService({
      SOCIAL_GOOGLE_EVENTS_ENABLED: 'true',
      SOCIAL_GOOGLE_CLIENT_ID: clientId,
      SOCIAL_GOOGLE_CLIENT_SECRET: 'test-client-secret',
    });
    verifier = new GoogleEventsVerifier(new AppConfigService(env), env);
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { 'cache-control': 'public, max-age=3600' },
        }),
    );
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each(Array.from(GOOGLE_EVENT_KINDS))(
    'maps only the exact allowlisted type %s',
    async (type, kind) => {
      const result = await verifier.verify(
        token({ events: { [type]: { subject } } }),
      );
      expect(result.targets).toEqual([
        { clientId, subject: subject.sub, kind },
      ]);
      expect(JSON.stringify(result)).not.toContain('unused@example.test');
      expect(fetchMock).toHaveBeenCalledWith(
        GOOGLE_RISC_JWKS,
        expect.objectContaining({ redirect: 'error' }),
      );
    },
  );

  it.each(['iss-sub', 'iss_sub', 'id_token_claims'])(
    'accepts the stable-subject format %s, not its email',
    async (subjectType) => {
      expect(
        (
          await verifier.verify(
            token({
              events: {
                [eventType]: {
                  subject: { ...subject, subject_type: subjectType },
                },
              },
            }),
          )
        ).targets[0].subject,
      ).toBe(subject.sub);
    },
  );

  it('accepts a historical SET without exp and does not treat optional exp as credential expiry', async () => {
    await expect(verifier.verify(token())).resolves.toMatchObject({
      provider: 'google',
    });
    await expect(
      verifier.verify(token({ exp: now - 10 })),
    ).resolves.toMatchObject({ provider: 'google' });
  });

  it('authenticates then safely ignores unknown/verification events without retaining their bodies', async () => {
    const result = await verifier.verify(
      token({
        events: {
          'https://unknown.test/event': { email: 'secret@example.test' },
          'https://schemas.openid.net/secevent/risc/event-type/verification': {
            state: 'private-test-state',
          },
        },
      }),
    );
    expect(result.targets).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/secret|private-test/);
  });

  it.each([
    { iss: 'accounts.google.com' },
    { aud: 'another-client' },
    { iat: now - 86_400 },
    { iat: now + 61 },
    { iat: 1.5 },
    { jti: '' },
  ])(
    'rejects wrong issuer/audience, stale/future time or missing jti %j',
    async (claims) => {
      await expect(verifier.verify(token(claims))).rejects.toThrow();
    },
  );

  it('accepts the documented trailing-slash Google issuer with the same canonical replay scope', async () => {
    const value = await verifier.verify(
      token({ iss: `${GOOGLE_RISC_ISSUER}/` }),
    );
    expect(value.provider).toBe('google');
    expect(value.targets).toHaveLength(1);
  });

  it('requires iat even though exp is optional', async () => {
    const value = jwt.sign(
      {
        iss: GOOGLE_RISC_ISSUER,
        aud: clientId,
        jti: 'missing-iat',
        events: { [eventType]: { subject } },
      },
      pair.privateKey,
      {
        algorithm: 'RS256',
        noTimestamp: true,
        header: { alg: 'RS256', typ: 'secevent+jwt', kid: 'test-key' },
      },
    );
    await expect(verifier.verify(value)).rejects.toThrow(UnauthorizedException);
  });

  it.each([
    { ...subject, subject_type: 'email' },
    { ...subject, iss: 'https://attacker.test' },
    { ...subject, sub: 'email@example.test' },
    {
      subject_type: 'id_token_claims',
      iss: GOOGLE_RISC_ISSUER,
      email: 'only-email@example.test',
    },
  ])(
    'rejects untrusted subject format/issuer or an email-only target %j',
    async (input) => {
      await expect(
        verifier.verify(token({ events: { [eventType]: { subject: input } } })),
      ).rejects.toThrow(BadRequestException);
    },
  );

  it('rejects a forged signature', async () => {
    const forged = jwt.sign(
      {
        iss: GOOGLE_RISC_ISSUER,
        aud: clientId,
        iat: now,
        jti: 'forged',
        events: { [eventType]: { subject } },
      },
      attacker.privateKey,
      {
        algorithm: 'RS256',
        header: { alg: 'RS256', typ: 'secevent+jwt', kid: 'test-key' },
      },
    );
    await expect(verifier.verify(forged)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it.each([
    { kid: '' },
    { typ: 'JWT' },
    { jku: 'http://127.0.0.1/private' },
    { x5u: 'https://attacker.test/key' },
  ])('rejects unsafe JWT header %j before fetching keys', async (header) => {
    await expect(verifier.verify(token({}, header))).rejects.toThrow(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects HS256 and unsigned JWTs without fetching', async () => {
    await expect(
      verifier.verify(
        jwt.sign({ iat: now }, 'secret', {
          algorithm: 'HS256',
          header: { alg: 'HS256', typ: 'secevent+jwt', kid: 'test-key' },
        }),
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(verifier.verify('e30.e30.')).rejects.toThrow(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, Buffer.from('jwt'), ['jwt']])(
    'rejects a non-text request body',
    async (body) => {
      await expect(verifier.verify(body)).rejects.toThrow(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { SOCIAL_GOOGLE_EVENTS_ENABLED: 'false' },
    { SOCIAL_GOOGLE_EVENTS_ENABLED: 'TRUE' },
    { SOCIAL_GOOGLE_EVENTS_ENABLED: 'true', SOCIAL_GOOGLE_CLIENT_ID: clientId },
    {
      SOCIAL_GOOGLE_EVENTS_ENABLED: 'true',
      SOCIAL_GOOGLE_CLIENT_ID: 'invalid-client',
      SOCIAL_GOOGLE_CLIENT_SECRET: 'secret',
    },
  ])(
    'keeps Google events off unless explicitly and validly configured %j',
    async (settings) => {
      const env = new ConfigService(settings);
      const disabled = new GoogleEventsVerifier(new AppConfigService(env), env);
      expect(disabled.googleEventsEnabled).toBe(false);
      await expect(disabled.verify(token())).rejects.toThrow(NotFoundException);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('shares a bounded cached JWKS fetch across concurrent tokens, throttling unknown kids', async () => {
    await Promise.all([
      verifier.verify(token()),
      verifier.verify(token({ jti: 'another-event' })),
    ]);
    await expect(
      verifier.verify(token({}, { kid: 'unknown-key' })),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      verifier.verify(token({}, { kid: 'another-unknown' })),
    ).rejects.toThrow(UnauthorizedException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    jest.setSystemTime((now + 31) * 1000);
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ keys: [{ ...publicJwk, kid: 'rotated-key' }] }),
        ),
    );
    await expect(
      verifier.verify(token({}, { kid: 'rotated-key' })),
    ).resolves.toMatchObject({ provider: 'google' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves transient JWKS outage responses during cooldown and recovers after refresh', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('unavailable', { status: 503 }),
    );
    await expect(verifier.verify(token())).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(verifier.verify(token())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    jest.setSystemTime((now + 31) * 1000);
    await expect(verifier.verify(token())).resolves.toMatchObject({
      provider: 'google',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed on JWKS errors and does not fetch arbitrary header URLs', async () => {
    fetchMock.mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(verifier.verify(token())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(
      fetchMock.mock.calls.every(([url]) => url === GOOGLE_RISC_JWKS),
    ).toBe(true);
  });
});
