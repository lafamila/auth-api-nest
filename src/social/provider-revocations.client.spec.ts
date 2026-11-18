import { ConfigService } from '@nestjs/config';
import { ProviderRevocationGrant } from './provider-revocations-grant';
import {
  ProviderRevocationError,
  ProviderRevocationsClient,
} from './provider-revocations.client';

const NOW = new Date('2026-11-18T00:00:00Z');
const SETTINGS = {
  SOCIAL_GOOGLE_CLIENT_ID: 'google-client',
  SOCIAL_NAVER_CLIENT_ID: 'naver-client',
  SOCIAL_NAVER_CLIENT_SECRET: 'naver-secret',
  SOCIAL_KAKAO_CLIENT_ID: 'kakao-client',
  SOCIAL_KAKAO_CLIENT_SECRET: 'kakao-secret',
};

describe('ProviderRevocationsClient (offline HTTP)', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const persist = jest.fn<Promise<void>, [ProviderRevocationGrant]>();

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    fetchMock = jest.spyOn(global, 'fetch');
    persist.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    persist.mockReset();
  });

  it('uses Google official revoke with refresh token in the POST body, never a URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await client().revoke(grant('google'), persist);
    expectRequest('https://oauth2.googleapis.com/revoke', {
      token: 'private-refresh-token',
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('uses a current Google access token when no refresh token was returned', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    await client().revoke(grant('google', { refreshToken: null }), persist);
    expectRequest('https://oauth2.googleapis.com/revoke', {
      token: 'private-access-token',
    });
  });

  it.each(['refresh_token', 'access_token'])(
    'uses current Naver RFC7009 revoke with %s and never legacy grant_type=delete',
    async (hint) => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
      await client().revoke(
        grant('naver', hint === 'access_token' ? { refreshToken: null } : {}),
        persist,
      );
      expectRequest('https://nid.naver.com/oauth2.0/revoke', {
        client_id: 'naver-client',
        client_secret: 'naver-secret',
        token:
          hint === 'refresh_token'
            ? 'private-refresh-token'
            : 'private-access-token',
        token_type_hint: hint,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('directly revokes an expired Naver access grant using its refresh token, without unnecessary refresh', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null));
    await client().revoke(
      grant('naver', { accessTokenExpiresAt: Date.now() - 1000 }),
      persist,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectRequest('https://nid.naver.com/oauth2.0/revoke', {
      client_id: 'naver-client',
      client_secret: 'naver-secret',
      token: 'private-refresh-token',
      token_type_hint: 'refresh_token',
    });
  });

  it('uses a server-only Kakao admin key and exact subject for tokenless legacy identities', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 123 }));
    await client({ SOCIAL_KAKAO_ADMIN_KEY: 'private-admin-key' }).revoke(
      grant('kakao', { accessToken: null, refreshToken: null }),
      persist,
    );
    expectRequest('https://kapi.kakao.com/v1/user/unlink', {
      target_id_type: 'user_id',
      target_id: '123',
    });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      authorization: 'KakaoAK private-admin-key',
    });
  });

  it('uses Kakao bearer unlink if no admin key is available', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 123 }));
    await client().revoke(grant('kakao'), persist);
    expectRequest('https://kapi.kakao.com/v1/user/unlink', {});
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      authorization: 'Bearer private-access-token',
    });
  });

  it('compares Kakao JSON Long subjects exactly without IEEE754 rounding', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"id":9223372036854775807}'));
    await expect(
      client({ SOCIAL_KAKAO_ADMIN_KEY: 'admin-key' }).revoke(
        grant('kakao', { subject: '9223372036854775807' }),
        persist,
      ),
    ).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response('{"id":9223372036854775806}'));
    await expect(
      client({ SOCIAL_KAKAO_ADMIN_KEY: 'admin-key' }).revoke(
        grant('kakao', { subject: '9223372036854775807' }),
        persist,
      ),
    ).rejects.toThrow(ProviderRevocationError);
  });

  it('refreshes Kakao expired access and durably replaces rotated tokens before unlink', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token_expires_in: 7200,
      }),
    );
    fetchMock.mockResolvedValueOnce(json({ id: 123 }));
    persist.mockImplementationOnce(async (updated) => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(updated).toMatchObject({
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        accessTokenExpiresAt: Date.now() + 3_600_000,
        refreshTokenExpiresAt: Date.now() + 7_200_000,
      });
    });
    await client().revoke(
      grant('kakao', { accessTokenExpiresAt: Date.now() - 1000 }),
      persist,
    );
    expectRequest('https://kauth.kakao.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: 'kakao-client',
      client_secret: 'kakao-secret',
      refresh_token: 'private-refresh-token',
    });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      authorization: 'Bearer rotated-access',
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not unlink with a refreshed grant if the durable lease update failed', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        access_token: 'rotated-access',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );
    persist.mockRejectedValueOnce(new Error('lease lost'));
    await expect(
      client().revoke(grant('kakao', { accessTokenExpiresAt: 0 }), persist),
    ).rejects.toThrow('lease lost');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats only documented Kakao no-connection (-101) as already unlinked for admin-key targets', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: -101 }, 400));
    await expect(
      client({ SOCIAL_KAKAO_ADMIN_KEY: 'admin-key' }).revoke(
        grant('kakao'),
        persist,
      ),
    ).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(json({ code: -101 }, 400));
    await expect(client().revoke(grant('kakao'), persist)).rejects.toThrow(
      ProviderRevocationError,
    );
  });

  it.each([
    ['google', 400, { error: 'invalid_token' }],
    ['google', 400, { error: 'invalid_request' }],
    ['naver', 400, { error: 'invalid_request' }],
    ['naver', 401, { error: 'unauthorized_client' }],
    ['naver', 503, { error: 'temporarily_unavailable' }],
    ['kakao', 401, { code: -401 }],
    ['kakao', 400, { code: -1 }],
    ['kakao', 400, { code: -2 }],
    ['google', 200, { error: 'invalid_token' }],
    ['naver', 200, { error: 'unauthorized_client' }],
    ['kakao', 200, { code: -401 }],
    ['kakao', 200, { id: 456 }],
    ['kakao', 200, { id: Number.MAX_SAFE_INTEGER + 1 }],
  ])(
    'does not turn %s HTTP %s or an unexpected identity into success',
    async (provider, status, body) => {
      fetchMock.mockResolvedValueOnce(json(body, status));
      await expect(
        client({ SOCIAL_KAKAO_ADMIN_KEY: 'admin-key' }).revoke(
          grant(provider),
          persist,
        ),
      ).rejects.toThrow(ProviderRevocationError);
    },
  );

  it.each([
    ['unconfigured client', { clientId: 'old-client' }],
    [
      'expired access without refresh',
      { accessTokenExpiresAt: 0, refreshToken: null },
    ],
    [
      'unknown access expiry without refresh',
      { accessTokenExpiresAt: null, refreshToken: null },
    ],
    [
      'expired access and refresh',
      { accessTokenExpiresAt: 0, refreshTokenExpiresAt: 0 },
    ],
  ])('requires reconnect before network for %s', async (_label, overrides) => {
    expect(client().canRevoke(grant('google', overrides))).toBe(false);
    await expect(
      client().revoke(grant('google', overrides), persist),
    ).rejects.toMatchObject({
      code: 'reauthentication_required',
      terminal: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send a Kakao token/admin key with an invalid subject or another client', () => {
    const adapter = client({ SOCIAL_KAKAO_ADMIN_KEY: 'admin-key' });
    expect(adapter.canRevoke(grant('kakao', { subject: 'not-an-id' }))).toBe(
      false,
    );
    expect(
      adapter.canRevoke(grant('kakao', { subject: '9223372036854775808' })),
    ).toBe(false);
    expect(adapter.canRevoke(grant('kakao', { clientId: 'other-app' }))).toBe(
      false,
    );
  });

  it.each([
    [
      'redirect',
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.invalid/' },
        }),
    ],
    [
      'oversized declared body',
      () => new Response('{}', { headers: { 'content-length': '65537' } }),
    ],
    ['oversized chunked body', () => new Response('a'.repeat(65537))],
    ['invalid UTF8', () => new Response(new Uint8Array([0xff]))],
    ['malformed JSON', () => new Response('private-token-error')],
  ] as const)(
    'rejects %s without following URLs or returning raw provider text',
    async (_label, response) => {
      fetchMock.mockResolvedValueOnce(response());
      const failure: unknown = await client()
        .revoke(grant('google'), persist)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderRevocationError);
      expect(JSON.stringify(failure)).not.toContain('private-token-error');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['fetch', 'body'])(
    'enforces a hard 5s timeout on stalled %s and clears timers',
    async (stage) => {
      const cancel = jest.fn();
      if (stage === 'fetch')
        fetchMock.mockImplementationOnce(
          () => new Promise<Response>(() => undefined),
        );
      else
        fetchMock.mockResolvedValueOnce(
          new Response(new ReadableStream<Uint8Array>({ cancel })),
        );
      const rejected = expect(
        client().revoke(grant('google'), persist),
      ).rejects.toMatchObject({ code: 'provider_timeout' });
      await jest.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      if (stage === 'body') expect(cancel).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('honors a nearer job deadline and never starts an expired request', async () => {
    await expect(
      client().revoke(grant('google'), persist, Date.now()),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>(() => undefined),
    );
    const rejected = expect(
      client().revoke(grant('google'), persist, Date.now() + 100),
    ).rejects.toMatchObject({ code: 'provider_timeout' });
    await jest.advanceTimersByTimeAsync(100);
    await rejected;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('sanitizes network exceptions without retaining raw token/secret or cause', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error('private-refresh-token naver-secret'),
    );
    const failure: unknown = await client()
      .revoke(grant('naver'), persist)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'provider_unavailable' });
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain('private-refresh-token');
    expect(JSON.stringify(failure)).not.toContain('naver-secret');
    expect(jest.getTimerCount()).toBe(0);
  });

  function expectRequest(url: string, body: Record<string, string>): void {
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe(url);
    expect(call[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(Object.fromEntries(call[1]?.body as URLSearchParams)).toEqual(body);
  }
});

function client(
  overrides: Record<string, string> = {},
): ProviderRevocationsClient {
  return new ProviderRevocationsClient(
    new ConfigService({ ...SETTINGS, ...overrides }),
  );
}

function grant(
  provider: string,
  overrides: Partial<ProviderRevocationGrant> = {},
): ProviderRevocationGrant {
  return {
    provider,
    clientId: `${provider}-client`,
    subject: provider === 'kakao' ? '123' : 'vendor-subject',
    accessToken: 'private-access-token',
    refreshToken: 'private-refresh-token',
    accessTokenExpiresAt: Date.now() + 3_600_000,
    refreshTokenExpiresAt: null,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
