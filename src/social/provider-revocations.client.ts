import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ProviderRevocationGrant,
  tokenExpiry,
  usableAccess,
  usableRefresh,
  validToken,
} from './provider-revocations-grant';

const URLS = {
  google: 'https://oauth2.googleapis.com/revoke',
  naver: 'https://nid.naver.com/oauth2.0/revoke',
  kakao: 'https://kapi.kakao.com/v1/user/unlink',
  kakaoRefresh: 'https://kauth.kakao.com/oauth/token',
} as const;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;
const HEADERS = {
  'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
  accept: 'application/json',
};

export class ProviderRevocationError extends Error {
  constructor(
    readonly code: string,
    readonly terminal = false,
  ) {
    super('Provider revocation failed');
  }
}

@Injectable()
export class ProviderRevocationsClient {
  constructor(private readonly config: ConfigService) {}

  canRevoke(grant: ProviderRevocationGrant): boolean {
    if (
      this.setting(`SOCIAL_${grant.provider.toUpperCase()}_CLIENT_ID`) !==
      grant.clientId
    )
      return false;
    if (grant.provider === 'kakao' && !validKakaoSubject(grant.subject))
      return false;
    if (
      grant.provider === 'kakao' &&
      this.adminKey() &&
      validKakaoSubject(grant.subject)
    )
      return true;
    if (grant.provider !== 'google' && !this.secret(grant)) return false;
    return usableAccess(grant) || usableRefresh(grant);
  }

  async revoke(
    grant: ProviderRevocationGrant,
    persistRefreshed: (grant: ProviderRevocationGrant) => Promise<void>,
    deadlineAt = Infinity,
  ): Promise<void> {
    if (!this.canRevoke(grant))
      throw new ProviderRevocationError('reauthentication_required', true);
    if (grant.provider === 'google') {
      // https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
      const response = await post(
        URLS.google,
        new URLSearchParams({
          token: (usableRefresh(grant)
            ? grant.refreshToken
            : grant.accessToken)!,
        }),
        {},
        deadlineAt,
      );
      requireSuccess(response);
      return;
    }
    if (grant.provider === 'naver') {
      // Current devguide 4.3 accepts refresh tokens directly; no refresh or legacy delete grant is needed.
      // https://developers.naver.com/docs/login/devguide/devguide.md
      const refresh = usableRefresh(grant);
      const response = await post(
        URLS.naver,
        new URLSearchParams({
          client_id: grant.clientId,
          client_secret: this.secret(grant),
          token: (refresh ? grant.refreshToken : grant.accessToken)!,
          token_type_hint: refresh ? 'refresh_token' : 'access_token',
        }),
        {},
        deadlineAt,
      );
      requireSuccess(response);
      return;
    }
    if (grant.provider !== 'kakao' || !validKakaoSubject(grant.subject)) {
      throw new ProviderRevocationError('invalid_target', true);
    }
    // https://developers.kakao.com/docs/ko/kakaologin/rest-api#unlink
    const adminKey = this.adminKey();
    if (!adminKey && !usableAccess(grant)) {
      const refreshed = await post(
        URLS.kakaoRefresh,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: grant.clientId,
          client_secret: this.secret(grant),
          refresh_token: grant.refreshToken!,
        }),
        {},
        deadlineAt,
      );
      requireSuccess(refreshed);
      const payload = jsonRecord(refreshed.body);
      if (
        !validToken(payload.access_token) ||
        typeof payload.token_type !== 'string' ||
        payload.token_type.toLowerCase() !== 'bearer' ||
        (payload.refresh_token != null && !validToken(payload.refresh_token))
      ) {
        throw new ProviderRevocationError('invalid_response');
      }
      grant = {
        ...grant,
        accessToken: payload.access_token,
        accessTokenExpiresAt: tokenExpiry(payload.expires_in),
        refreshToken:
          typeof payload.refresh_token === 'string'
            ? payload.refresh_token
            : grant.refreshToken,
        refreshTokenExpiresAt:
          payload.refresh_token_expires_in == null
            ? grant.refreshTokenExpiresAt
            : tokenExpiry(payload.refresh_token_expires_in),
      };
      await persistRefreshed(grant);
    }
    const response = await post(
      URLS.kakao,
      new URLSearchParams(
        adminKey
          ? {
              target_id_type: 'user_id',
              target_id: grant.subject,
            }
          : {},
      ),
      {
        authorization: adminKey
          ? `KakaoAK ${adminKey}`
          : `Bearer ${grant.accessToken!}`,
      },
      deadlineAt,
    );
    // -101 specifically means the app/user connection does not exist. Invalid tokens (-401) do not.
    // https://developers.kakao.com/docs/ko/rest-api/error-code
    const payload = jsonRecord(response.body);
    if (adminKey && response.status === 400 && payload.code === -101) return;
    requireSuccess(response);
    const id = payload.id;
    const returned =
      typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
    if (returned !== grant.subject)
      throw new ProviderRevocationError('invalid_response');
  }

  private setting(key: string): string {
    const value: unknown = this.config.get(key);
    return typeof value === 'string' && !/\p{Cc}/u.test(value)
      ? value.trim()
      : '';
  }

  private secret(grant: ProviderRevocationGrant): string {
    return this.setting(`SOCIAL_${grant.provider.toUpperCase()}_CLIENT_SECRET`);
  }

  private adminKey(): string {
    return this.setting('SOCIAL_KAKAO_ADMIN_KEY');
  }
}

function validKakaoSubject(subject: string): boolean {
  return (
    /^[1-9][0-9]{0,18}$/.test(subject) &&
    BigInt(subject) <= 9_223_372_036_854_775_807n
  );
}

interface ProviderResponse {
  status: number;
  body: string;
}

function jsonRecord(body: string): Record<string, unknown> {
  try {
    // Node 22+ exposes the original primitive source to avoid rounding Kakao Long IDs.
    const value: unknown = JSON.parse(
      body,
      (key: string, value: unknown, context?: { source?: string }): unknown => {
        if (
          key === 'id' &&
          typeof value === 'number' &&
          !Number.isSafeInteger(value)
        ) {
          if (!context?.source || !validKakaoSubject(context.source)) {
            throw new ProviderRevocationError('invalid_response');
          }
          return context.source;
        }
        return value;
      },
    );
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Provider bodies are untrusted and never enter errors or logs. */
  }
  throw new ProviderRevocationError('invalid_response');
}

function requireSuccess(response: ProviderResponse): void {
  if (response.status !== 200) {
    // In particular, Google's generic 400 is not proof of prior revocation.
    throw new ProviderRevocationError('provider_rejected');
  }
  if (response.body.trim()) {
    const payload = jsonRecord(response.body);
    if (
      'error' in payload ||
      'error_code' in payload ||
      ('code' in payload && payload.code !== 0)
    ) {
      throw new ProviderRevocationError('provider_rejected');
    }
  }
}

async function post(
  url: string,
  body: URLSearchParams,
  headers: Record<string, string> = {},
  deadlineAt = Infinity,
): Promise<ProviderResponse> {
  if (!(Object.values(URLS) as string[]).includes(url))
    throw new ProviderRevocationError('invalid_target', true);
  const timeout = Math.min(TIMEOUT_MS, deadlineAt - Date.now());
  if (timeout <= 0)
    throw new ProviderRevocationError('deadline_exceeded', true);
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderRevocationError('provider_timeout'));
    }, timeout);
  });
  const read = async (): Promise<ProviderResponse> => {
    response = await fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, ...headers },
      body,
      redirect: 'error',
      signal: controller.signal,
    });
    if (controller.signal.aborted)
      throw new ProviderRevocationError('provider_timeout');
    if (
      response.redirected ||
      response.status < 200 ||
      (response.status >= 300 && response.status < 400) ||
      Number(response.headers.get('content-length')) > MAX_BYTES
    )
      throw new ProviderRevocationError('invalid_response');
    if (!response.body) return { status: response.status, body: '' };
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES)
          throw new ProviderRevocationError('invalid_response');
        chunks.push(value);
      }
    } finally {
      // Cancel before releasing the lock on an incomplete/oversized stream.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return {
      status: response.status,
      body: new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      ),
    };
  };
  try {
    return await Promise.race([read(), deadline]);
  } catch (error) {
    controller.abort();
    if (reader) void reader.cancel().catch(() => undefined);
    else if (response?.body) void response.body.cancel().catch(() => undefined);
    throw error instanceof ProviderRevocationError
      ? error
      : new ProviderRevocationError('provider_unavailable');
  } finally {
    clearTimeout(timer);
  }
}
