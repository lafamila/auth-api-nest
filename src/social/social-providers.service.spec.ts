import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AppConfigService } from '../config/app-config.service';
import { SocialProvidersService } from './social-providers.service';

const STATE = 'bound-state +/&=?#';
const CHALLENGE = 'a'.repeat(43);
const VERIFIER = 'b'.repeat(64);
const INPUT = { code: 'server-code', state: STATE, codeVerifier: VERIFIER };
const FAILURE = 'Social provider authentication failed';
const TOKEN = {
  access_token: 'private-access-token',
  token_type: 'Bearer',
  refresh_token: 'private-refresh-token',
  id_token: 'unvalidated-id-token',
};

const PROVIDER_CASES = [
  {
    key: 'google',
    label: 'Google',
    authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    profile: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    payload: {
      sub: 'google-stable-subject',
      email: 'member@gmail.com',
      email_verified: true,
      name: 'Google Member',
    },
    identity: {
      subject: 'google-stable-subject',
      email: 'member@gmail.com',
      emailVerified: true,
      name: 'Google Member',
    },
  },
  {
    key: 'kakao',
    label: 'Kakao',
    authorization: 'https://kauth.kakao.com/oauth/authorize',
    token: 'https://kauth.kakao.com/oauth/token',
    profile: 'https://kapi.kakao.com/v2/user/me',
    scope: 'account_email,profile_nickname',
    payload: {
      id: 123456789,
      kakao_account: {
        email: 'member@kakao.com',
        is_email_valid: true,
        is_email_verified: true,
        profile: { nickname: 'Kakao Member' },
      },
    },
    identity: {
      subject: '123456789',
      email: 'member@kakao.com',
      emailVerified: true,
      name: 'Kakao Member',
    },
  },
  {
    key: 'naver',
    label: 'Naver',
    authorization: 'https://nid.naver.com/oauth2/authorize',
    token: 'https://nid.naver.com/oauth2/token',
    profile: 'https://openapi.naver.com/v1/nid/me',
    scope: 'openid profile',
    payload: {
      resultcode: '00',
      message: 'success',
      response: {
        id: 'naver-App_Scoped+Id/==',
        email: 'member@naver.com',
        name: 'Naver Member',
      },
    },
    identity: {
      subject: 'naver-App_Scoped+Id/==',
      email: 'member@naver.com',
      emailVerified: false,
      name: 'Naver Member',
    },
  },
];

describe('SocialProvidersService', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('is injectable using the existing AppConfigService', async () => {
    const module = await Test.createTestingModule({
      providers: [
        SocialProvidersService,
        { provide: AppConfigService, useValue: config() },
      ],
    }).compile();
    expect(module.get(SocialProvidersService).list()).toEqual([
      { key: 'google', label: 'Google' },
      { key: 'kakao', label: 'Kakao' },
      { key: 'naver', label: 'Naver' },
    ]);
    await module.close();
  });

  it('lists only configured public keys and labels without secrets', () => {
    expect(
      service({
        SOCIAL_KAKAO_CLIENT_SECRET: '',
        SOCIAL_NAVER_CLIENT_ID: '',
      }).list(),
    ).toEqual([{ key: 'google', label: 'Google' }]);
    expect(
      service({
        SOCIAL_GOOGLE_CLIENT_SECRET: '',
        SOCIAL_KAKAO_CLIENT_SECRET: '',
        SOCIAL_NAVER_CLIENT_SECRET: '',
      }).list(),
    ).toEqual([]);
  });

  describe.each(PROVIDER_CASES)('$key adapter', (provider) => {
    it('maps the fixed endpoint, exact scope, state, central callback and S256 challenge', () => {
      const input = {
        state: STATE,
        codeChallenge: CHALLENGE,
        redirect_uri: 'https://untrusted.example/callback',
        email: 'browser@example.com',
      };
      const url = new URL(service().authorizationUrl(provider.key, input));
      expect(`${url.origin}${url.pathname}`).toBe(provider.authorization);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        response_type: 'code',
        client_id: `${provider.key}-client`,
        redirect_uri: callback(provider.key),
        scope: provider.scope,
        state: STATE,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
      });
      expect(url.toString()).not.toContain('secret');
      expect(url.toString()).not.toContain(VERIFIER);
      expect(url.hash).toBe('');
      expect(service().clientIdFor(provider.key)).toBe(
        `${provider.key}-client`,
      );
    });

    it('confidentially exchanges code + verifier and fetches identity only from the server profile', async () => {
      queueProfile(provider.payload);
      const input = {
        ...INPUT,
        email: 'browser@example.com',
        sub: 'browser-subject',
        id_token: 'browser-id-token',
        redirect_uri: 'https://untrusted.example/callback',
      };
      await expect(
        service().exchangeCode(provider.key, input),
      ).resolves.toEqual({
        provider: provider.key,
        providerClientId: `${provider.key}-client`,
        ...provider.identity,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [tokenUrl, tokenRequest] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe(provider.token);
      expect(tokenRequest).toMatchObject({
        method: 'POST',
        redirect: 'error',
        signal: expect.any(AbortSignal),
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
          accept: 'application/json',
        },
      });
      expect(tokenRequest?.body).toBeInstanceOf(URLSearchParams);
      expect(Object.fromEntries(tokenRequest?.body as URLSearchParams)).toEqual(
        {
          grant_type: 'authorization_code',
          client_id: `${provider.key}-client`,
          client_secret: `${provider.key}-private-secret`,
          redirect_uri: callback(provider.key),
          code: INPUT.code,
          code_verifier: VERIFIER,
          ...(provider.key === 'naver' ? { state: STATE } : {}),
        },
      );
      expect(fetchMock.mock.calls[1]).toEqual([
        provider.profile,
        {
          method: 'GET',
          redirect: 'error',
          signal: expect.any(AbortSignal),
          headers: {
            authorization: 'Bearer private-access-token',
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
          },
        },
      ]);
    });

    it.each(['CLIENT_ID', 'CLIENT_SECRET'])(
      'requires a nonblank %s for listing and all operations',
      async (credential) => {
        const adapter = service({
          [`SOCIAL_${provider.key.toUpperCase()}_${credential}`]: '  ',
        });
        expect(adapter.list()).not.toContainEqual({
          key: provider.key,
          label: provider.label,
        });
        expect(() => adapter.clientIdFor(provider.key)).toThrow(
          BadRequestException,
        );
        expect(() =>
          adapter.authorizationUrl(provider.key, {
            state: STATE,
            codeChallenge: CHALLENGE,
          }),
        ).toThrow(BadRequestException);
        await expect(adapter.exchangeCode(provider.key, INPUT)).rejects.toThrow(
          BadRequestException,
        );
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('namespaces subjects with the configured provider client ID', async () => {
      queueProfile(provider.payload);
      const first = await service().exchangeCode(provider.key, INPUT);
      queueProfile(provider.payload);
      const second = await service({
        [`SOCIAL_${provider.key.toUpperCase()}_CLIENT_ID`]: 'another-client',
      }).exchangeCode(provider.key, INPUT);
      expect(first.subject).toBe(second.subject);
      expect(first.providerClientId).not.toBe(second.providerClientId);
      expect(second.providerClientId).toBe('another-client');
    });

    it('rejects provider token errors even with HTTP 200 and a token-looking payload', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          ...TOKEN,
          error: 'invalid_grant',
          error_description: `${provider.key}-private-secret`,
          ...(provider.key === 'kakao' ? { error_code: 'KOE320' } : {}),
        }),
      );
      await expect(service().exchangeCode(provider.key, INPUT)).rejects.toThrow(
        FAILURE,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects missing PKCE instead of silently downgrading', async () => {
      expect(() =>
        service().authorizationUrl(provider.key, {
          state: STATE,
          codeChallenge: '',
        }),
      ).toThrow(BadRequestException);
      await expect(
        service().exchangeCode(provider.key, { ...INPUT, codeVerifier: '' }),
      ).rejects.toThrow(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    'unknown',
    'toString',
    '__proto__',
    'constructor',
    'https://attacker.example/token',
    'google/../../token',
    'GOOGLE',
  ])(
    'rejects an unregistered provider key %s without network access',
    async (key) => {
      expect(() => service().clientIdFor(key)).toThrow(
        'Social provider is unavailable',
      );
      expect(() =>
        service().authorizationUrl(key, {
          state: STATE,
          codeChallenge: CHALLENGE,
        }),
      ).toThrow('Social provider is unavailable');
      await expect(service().exchangeCode(key, INPUT)).rejects.toThrow(
        'Social provider is unavailable',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['', '  ', 'state\nvalue', 'a'.repeat(4097)])(
    'rejects invalid state before creating URLs or sending a code: %j',
    async (state) => {
      expect(() =>
        service().authorizationUrl('google', {
          state,
          codeChallenge: CHALLENGE,
        }),
      ).toThrow(BadRequestException);
      await expect(
        service().exchangeCode('google', { ...INPUT, state }),
      ).rejects.toThrow(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['', ' ', 'code\r\nheader', 'a'.repeat(4097)])(
    'rejects invalid codes: %j',
    async (code) => {
      await expect(
        service().exchangeCode('google', { ...INPUT, code }),
      ).rejects.toThrow(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['short', 'a'.repeat(42), 'a'.repeat(44), '+'.repeat(43)])(
    'requires a base64url S256 challenge: %s',
    (codeChallenge) => {
      expect(() =>
        service().authorizationUrl('google', { state: STATE, codeChallenge }),
      ).toThrow(BadRequestException);
    },
  );

  it.each(['short', 'a'.repeat(42), 'a'.repeat(129), '+'.repeat(43)])(
    'requires a valid PKCE verifier: %s',
    async (codeVerifier) => {
      await expect(
        service().exchangeCode('google', { ...INPUT, codeVerifier }),
      ).rejects.toThrow(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    'custom-app://callback',
    'https://user:pass@example.com/',
    'not a URL',
  ])(
    'rejects non-HTTP or credentialed callback configuration: %s',
    async (url) => {
      const settings = config();
      jest.spyOn(settings, 'socialCallbackUrl').mockReturnValue(url);
      const adapter = new SocialProvidersService(settings);
      expect(() =>
        adapter.authorizationUrl('google', {
          state: STATE,
          codeChallenge: CHALLENGE,
        }),
      ).toThrow('Social provider is unavailable');
      await expect(adapter.exchangeCode('google', INPUT)).rejects.toThrow(
        'Social provider is unavailable',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  describe('authoritative email evidence', () => {
    it.each([
      ['Gmail verified', 'member@gmail.com', true, undefined, true],
      ['Gmail unverified', 'member@gmail.com', false, undefined, false],
      [
        'Gmail missing verification',
        'member@gmail.com',
        undefined,
        undefined,
        false,
      ],
      ['Gmail string flag', 'member@gmail.com', 'true', undefined, false],
      ['Workspace verified', 'member@work.example', true, 'work.example', true],
      [
        'Workspace unverified',
        'member@work.example',
        false,
        'work.example',
        false,
      ],
      ['third party verified', 'member@example.com', true, undefined, false],
      ['third party unverified', 'member@example.com', false, undefined, false],
      ['empty hosted domain', 'member@example.com', true, '', false],
      ['whitespace hosted domain', 'member@example.com', true, ' ', false],
      [
        'Gmail suffix spoof',
        'member@gmail.com.evil.example',
        true,
        undefined,
        false,
      ],
      ['Gmail subdomain', 'member@mail.gmail.com', true, undefined, false],
      ['missing email', undefined, true, 'work.example', false],
      ['null email', null, true, 'work.example', false],
      ['blank email', '', true, 'work.example', false],
    ])('Google: %s', async (_label, email, verified, hd, expected) => {
      queueProfile({ sub: 'google-sub', email, email_verified: verified, hd });
      await expect(
        service().exchangeCode('google', INPUT),
      ).resolves.toMatchObject({
        email: email || null,
        emailVerified: expected,
        name: 'Google user',
      });
    });

    it.each([
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
      [undefined, true, false],
      [true, undefined, false],
      [undefined, undefined, false],
      ['true', true, false],
      [true, 'true', false],
      [1, 1, false],
    ])(
      'Kakao: valid=%s verified=%s => %s',
      async (valid, verified, expected) => {
        queueProfile({
          id: 123,
          kakao_account: {
            email: 'member@kakao.com',
            is_email_valid: valid,
            is_email_verified: verified,
          },
        });
        await expect(
          service().exchangeCode('kakao', INPUT),
        ).resolves.toMatchObject({
          emailVerified: expected,
          name: 'Kakao user',
        });
      },
    );

    it.each([undefined, null, ''])(
      'Kakao: absent email %j cannot be verified',
      async (email) => {
        queueProfile({
          id: 123,
          kakao_account: {
            email,
            is_email_valid: true,
            is_email_verified: true,
          },
        });
        await expect(
          service().exchangeCode('kakao', INPUT),
        ).resolves.toMatchObject({
          email: null,
          emailVerified: false,
        });
      },
    );

    it('Kakao: masked expired email uses manual proof instead of failing login', async () => {
      queueProfile({
        id: 123,
        kakao_account: {
          email: 'm***@*****.com',
          is_email_valid: false,
          is_email_verified: false,
        },
      });
      await expect(
        service().exchangeCode('kakao', INPUT),
      ).resolves.toMatchObject({ email: null, emailVerified: false });
    });

    it('Kakao: optional account/profile information can be absent', async () => {
      queueProfile({ id: 123 });
      await expect(
        service().exchangeCode('kakao', INPUT),
      ).resolves.toMatchObject({
        subject: '123',
        email: null,
        emailVerified: false,
        name: 'Kakao user',
      });
    });

    it.each(['member@naver.com', 'member@example.com', undefined])(
      'Naver: never attests email ownership, including fabricated verification fields: %s',
      async (email) => {
        queueProfile({
          resultcode: '00',
          response: {
            id: 'Naver-Subject',
            email,
            email_verified: true,
            is_email_valid: true,
            is_email_verified: true,
            nickname: 'Naver Nickname',
          },
        });
        await expect(
          service().exchangeCode('naver', INPUT),
        ).resolves.toMatchObject({
          email: email ?? null,
          emailVerified: false,
          name: 'Naver Nickname',
        });
      },
    );

    it('normalizes email consistently without changing the stable subject', async () => {
      queueProfile({
        sub: 'CaseSensitiveSubject',
        email: '  Member@GMAIL.COM  ',
        email_verified: true,
      });
      await expect(
        service().exchangeCode('google', INPUT),
      ).resolves.toMatchObject({
        subject: 'CaseSensitiveSubject',
        email: 'member@gmail.com',
        emailVerified: true,
      });
    });
  });

  describe('profile validation', () => {
    it.each(['google', 'naver'])(
      '%s rejects malformed stable subjects',
      async (provider) => {
        for (const id of [
          undefined,
          null,
          '',
          ' ',
          ' padded',
          'padded ',
          'a\nb',
          123,
          {},
          [],
          'x'.repeat(256),
        ]) {
          queueProfile(
            provider === 'google'
              ? { sub: id }
              : { resultcode: '00', response: { id } },
          );
          await expect(service().exchangeCode(provider, INPUT)).rejects.toThrow(
            FAILURE,
          );
        }
      },
    );

    it.each([
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      '',
      '0123',
      '+123',
      '1.2',
      ' 123',
      '0',
      '9223372036854775808',
      {},
      null,
    ])('Kakao rejects ambiguous or invalid numeric subject %j', async (id) => {
      queueProfile({ id });
      await expect(service().exchangeCode('kakao', INPUT)).rejects.toThrow(
        FAILURE,
      );
    });

    it.each([123, '123', '9223372036854775807'])(
      'Kakao preserves valid integral subject %s',
      async (id) => {
        queueProfile({ id });
        await expect(
          service().exchangeCode('kakao', INPUT),
        ).resolves.toMatchObject({ subject: String(id) });
      },
    );

    it.each([
      ['google', { sub: 'sub', email: 'not-an-email' }],
      ['google', { sub: 'sub', email: {} }],
      [
        'google',
        { sub: 'sub', email: 'first@example.com\nsecond@example.com' },
      ],
      ['google', { sub: 'sub', name: {} }],
      ['google', { sub: 'sub', name: 'x'.repeat(256) }],
      ['google', { sub: 'sub', hd: [] }],
      ['kakao', { id: 123, kakao_account: [] }],
      ['kakao', { id: 123, kakao_account: { profile: 'invalid' } }],
      ['kakao', { id: 123, kakao_account: { email: 'invalid' } }],
      ['kakao', { code: -1, id: 123, msg: 'private-access-token' }],
      ['naver', { resultcode: '00', response: null }],
      ['naver', { resultcode: '00', response: [] }],
      ['naver', { resultcode: '00', response: { id: 'sub', email: false } }],
      [
        'naver',
        {
          resultcode: '01',
          response: { id: 'sub' },
          message: 'private-access-token',
        },
      ],
      ['naver', { response: { id: 'sub' } }],
    ])('%s rejects malformed/error profiles', async (provider, payload) => {
      queueProfile(payload);
      await expect(service().exchangeCode(provider, INPUT)).rejects.toThrow(
        FAILURE,
      );
    });

    it('does not copy profile fields or email evidence from the token response', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          ...TOKEN,
          sub: 'untrusted-token-sub',
          email: 'token@gmail.com',
          email_verified: true,
          name: 'Token Name',
        }),
      );
      fetchMock.mockResolvedValueOnce(json({ sub: 'server-userinfo-sub' }));
      await expect(service().exchangeCode('google', INPUT)).resolves.toEqual({
        provider: 'google',
        providerClientId: 'google-client',
        subject: 'server-userinfo-sub',
        email: null,
        emailVerified: false,
        name: 'Google user',
      });
    });

    it('never falls back to an ID token when UserInfo has no subject', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          ...TOKEN,
          id_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlIn0.',
        }),
      );
      fetchMock.mockResolvedValueOnce(
        json({ email: 'member@gmail.com', email_verified: true }),
      );
      await expect(service().exchangeCode('google', INPUT)).rejects.toThrow(
        FAILURE,
      );
    });

    it('does not require optional Naver profile details', async () => {
      queueProfile({ resultcode: '00', response: { id: 'Naver-Subject' } });
      await expect(
        service().exchangeCode('naver', INPUT),
      ).resolves.toMatchObject({
        email: null,
        emailVerified: false,
        name: 'Naver user',
      });
    });
  });

  describe.each(['token', 'profile'])('%s HTTP boundary', (stage) => {
    it.each([
      [
        'failed HTTP',
        () => json({ error_description: TOKEN.access_token }, 503),
      ],
      [
        'HTTP redirect',
        () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://attacker.example/' },
          }),
      ],
      ['malformed JSON', () => new Response(`not-json-${TOKEN.access_token}`)],
      ['null JSON', () => json(null)],
      ['array JSON', () => json([])],
      ['primitive JSON', () => json(TOKEN.access_token)],
      [
        'provider error',
        () =>
          json({
            ...TOKEN,
            sub: 'sub',
            error: 'provider-error',
            error_description: TOKEN.access_token,
          }),
      ],
      [
        'provider error code',
        () => json({ ...TOKEN, sub: 'sub', error_code: 'KOE320' }),
      ],
      [
        'oversized content length',
        () => new Response('{}', { headers: { 'content-length': '65537' } }),
      ],
      [
        'oversized body without content length',
        () => new Response('x'.repeat(65537)),
      ],
      [
        'oversized body with understated content length',
        () =>
          new Response('x'.repeat(65537), {
            headers: { 'content-length': '2' },
          }),
      ],
      [
        'UTF-8 byte size, not character count',
        () => json({ sub: 'sub', padding: '\u00e9'.repeat(40000) }),
      ],
      [
        'invalid UTF-8',
        () => new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])),
      ],
      ['empty body', () => new Response(null)],
    ] as const)('sanitizes %s', async (_label, response) => {
      queueStage(stage, response());
      await expect(service().exchangeCode('google', INPUT)).rejects.toThrow(
        FAILURE,
      );
      expect(fetchMock).toHaveBeenCalledTimes(stage === 'token' ? 1 : 2);
    });

    it('sanitizes fetch errors without leaking a code, secret, token or error cause', async () => {
      if (stage === 'profile') fetchMock.mockResolvedValueOnce(json(TOKEN));
      fetchMock.mockRejectedValueOnce(
        new Error(
          `sensitive ${TOKEN.access_token} ${INPUT.code} google-private-secret`,
        ),
      );
      const error: unknown = await service()
        .exchangeCode('google', INPUT)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(BadGatewayException);
      expect((error as Error).message).toBe(FAILURE);
      expect((error as Error).cause).toBeUndefined();
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(TOKEN.access_token);
      expect(serialized).not.toContain(INPUT.code);
      expect(serialized).not.toContain('google-private-secret');
    });

    it('aborts a stalled fetch at the hard deadline', async () => {
      jest.useFakeTimers();
      if (stage === 'profile') fetchMock.mockResolvedValueOnce(json(TOKEN));
      fetchMock.mockImplementationOnce(
        () => new Promise<Response>(() => undefined),
      );
      const rejected = expect(
        service().exchangeCode('google', INPUT),
      ).rejects.toThrow(FAILURE);
      await jest.advanceTimersByTimeAsync(5_000);
      await rejected;
      const request = fetchMock.mock.calls[stage === 'token' ? 0 : 1][1];
      expect(request?.signal?.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('applies the same deadline to a stalled response body and cancels its reader', async () => {
      jest.useFakeTimers();
      const cancel = jest.fn();
      queueStage(
        stage,
        new Response(new ReadableStream<Uint8Array>({ cancel })),
      );
      const rejected = expect(
        service().exchangeCode('google', INPUT),
      ).rejects.toThrow(FAILURE);
      await jest.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('rejects stream read errors', async () => {
      queueStage(
        stage,
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error(TOKEN.access_token));
            },
          }),
        ),
      );
      await expect(service().exchangeCode('google', INPUT)).rejects.toThrow(
        FAILURE,
      );
    });

    it('counts accumulated chunks and cancels when the size limit is exceeded', async () => {
      const cancel = jest.fn();
      queueStage(
        stage,
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(32_768));
              controller.enqueue(new Uint8Array(32_768));
              controller.enqueue(new Uint8Array(1));
            },
            cancel,
          }),
        ),
      );
      await expect(service().exchangeCode('google', INPUT)).rejects.toThrow(
        FAILURE,
      );
      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    { token_type: 'Bearer' },
    { ...TOKEN, access_token: '' },
    { ...TOKEN, access_token: 123 },
    { ...TOKEN, access_token: 'token\r\nInjected: header' },
    { ...TOKEN, access_token: 'x'.repeat(16_385) },
    { ...TOKEN, token_type: 'MAC' },
    { ...TOKEN, token_type: undefined },
  ])(
    'rejects malformed or unsupported bearer tokens without requesting profiles',
    async (token) => {
      fetchMock.mockResolvedValueOnce(json(token));
      await expect(service().exchangeCode('google', INPUT)).rejects.toThrow(
        FAILURE,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('clears deadline timers after success', async () => {
    jest.useFakeTimers();
    queueProfile({ sub: 'sub' });
    await expect(
      service().exchangeCode('google', INPUT),
    ).resolves.toMatchObject({ subject: 'sub' });
    expect(jest.getTimerCount()).toBe(0);
  });

  function queueProfile(payload: unknown): void {
    fetchMock.mockResolvedValueOnce(json(TOKEN));
    fetchMock.mockResolvedValueOnce(json(payload));
  }

  function queueStage(stage: string, response: Response): void {
    if (stage === 'profile') fetchMock.mockResolvedValueOnce(json(TOKEN));
    fetchMock.mockResolvedValueOnce(response);
  }
});

function config(overrides: Record<string, string> = {}): AppConfigService {
  return new AppConfigService(
    new ConfigService({
      ISSUER_URL: 'https://auth.example',
      SOCIAL_GOOGLE_CLIENT_ID: 'google-client',
      SOCIAL_GOOGLE_CLIENT_SECRET: 'google-private-secret',
      SOCIAL_KAKAO_CLIENT_ID: 'kakao-client',
      SOCIAL_KAKAO_CLIENT_SECRET: 'kakao-private-secret',
      SOCIAL_NAVER_CLIENT_ID: 'naver-client',
      SOCIAL_NAVER_CLIENT_SECRET: 'naver-private-secret',
      ...overrides,
    }),
  );
}

function service(
  overrides: Record<string, string> = {},
): SocialProvidersService {
  return new SocialProvidersService(config(overrides));
}

function callback(provider: string): string {
  return `https://auth.example/oauth/social/${provider}/callback`;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
