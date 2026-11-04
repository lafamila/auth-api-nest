import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { isEmail } from 'class-validator';
import { AppConfigService } from '../config/app-config.service';
import {
  SocialAuthorizationInput,
  SocialCodeExchangeInput,
  SocialIdentityProfile,
} from './social-provider.types';

type ProviderProfile = Omit<
  SocialIdentityProfile,
  'provider' | 'providerClientId'
>;

interface ProviderDefinition {
  key: string;
  label: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  profileEndpoint: string;
  scope: string;
  pkce: boolean;
  tokenState?: boolean;
  parseProfile: (payload: Record<string, unknown>) => ProviderProfile;
}

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const AUTHENTICATION_FAILED = 'Social provider authentication failed';

const PROVIDERS: readonly ProviderDefinition[] = [
  {
    key: 'google',
    label: 'Google',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    profileEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    pkce: true,
    parseProfile: googleProfile,
  },
  {
    key: 'kakao',
    label: 'Kakao',
    authorizationEndpoint: 'https://kauth.kakao.com/oauth/authorize',
    tokenEndpoint: 'https://kauth.kakao.com/oauth/token',
    profileEndpoint: 'https://kapi.kakao.com/v2/user/me',
    scope: 'account_email,profile_nickname',
    // S256 discovery support and REST confirmation: https://devtalk.kakao.com/t/oauth2-pkce/144590
    pkce: true,
    parseProfile: kakaoProfile,
  },
  {
    key: 'naver',
    label: 'Naver',
    // OIDC + PKCE uses /oauth2/, not the legacy /oauth2.0/ endpoints.
    // https://developers.naver.com/docs/login/devguide/devguide.md (section 3.5)
    authorizationEndpoint: 'https://nid.naver.com/oauth2/authorize',
    tokenEndpoint: 'https://nid.naver.com/oauth2/token',
    profileEndpoint: 'https://openapi.naver.com/v1/nid/me',
    scope: 'openid profile',
    pkce: true,
    tokenState: true,
    parseProfile: naverProfile,
  },
];

@Injectable()
export class SocialProvidersService {
  constructor(private readonly config: AppConfigService) {}

  list(): Array<{ key: string; label: string }> {
    return PROVIDERS.filter((provider) => {
      const { clientId, clientSecret } = this.config.socialProviderCredentials(
        provider.key,
      );
      return clientId.trim() && clientSecret.trim();
    }).map(({ key, label }) => ({ key, label }));
  }

  clientIdFor(provider: string): string {
    return this.configuredProvider(provider).credentials.clientId;
  }

  authorizationUrl(provider: string, input: SocialAuthorizationInput): string {
    const { definition, credentials } = this.configuredProvider(provider);
    requireInput(input.state);
    if (definition.pkce && !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
      throw new BadRequestException('Invalid social authorization request');
    }
    const url = new URL(definition.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: credentials.clientId,
      redirect_uri: this.callbackUrl(definition.key),
      scope: definition.scope,
      state: input.state,
    }).toString();
    if (definition.pkce) {
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  async exchangeCode(
    provider: string,
    input: SocialCodeExchangeInput,
  ): Promise<SocialIdentityProfile> {
    const { definition, credentials } = this.configuredProvider(provider);
    requireInput(input.code);
    requireInput(input.state);
    if (
      definition.pkce &&
      !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)
    ) {
      throw new BadRequestException('Invalid social authorization request');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: this.callbackUrl(definition.key),
      code: input.code,
    });
    if (definition.pkce) {
      body.set('code_verifier', input.codeVerifier);
    }
    if (definition.tokenState) {
      body.set('state', input.state);
    }
    try {
      const token = await requestJson(definition.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
          accept: 'application/json',
        },
        body,
      });
      if (
        typeof token.access_token !== 'string' ||
        token.access_token.length > 16_384 ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(token.access_token) ||
        typeof token.token_type !== 'string' ||
        token.token_type.toLowerCase() !== 'bearer'
      ) {
        throw new Error(AUTHENTICATION_FAILED);
      }
      // Browser claims and token-response ID tokens never supply identity data.
      const payload = await requestJson(definition.profileEndpoint, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token.access_token}`,
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
        },
      });
      return {
        provider: definition.key,
        providerClientId: credentials.clientId,
        ...definition.parseProfile(payload),
      };
    } catch {
      throw new BadGatewayException(AUTHENTICATION_FAILED);
    }
  }

  private configuredProvider(provider: string) {
    const definition = PROVIDERS.find(({ key }) => key === provider);
    if (!definition) {
      throw new BadRequestException('Social provider is unavailable');
    }
    const { clientId, clientSecret } = this.config.socialProviderCredentials(
      definition.key,
    );
    if (!clientId.trim() || !clientSecret.trim()) {
      throw new BadRequestException('Social provider is unavailable');
    }
    return {
      definition,
      credentials: {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      },
    };
  }

  private callbackUrl(provider: string): string {
    try {
      const url = new URL(this.config.socialCallbackUrl(provider));
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      ) {
        throw new Error('Invalid callback');
      }
      return url.toString();
    } catch {
      throw new BadRequestException('Social provider is unavailable');
    }
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(AUTHENTICATION_FAILED));
    }, REQUEST_TIMEOUT_MS);
  });
  const read = async () => {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
    });
    if (
      !response.ok ||
      response.redirected ||
      !response.body ||
      Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES
    ) {
      throw new Error(AUTHENTICATION_FAILED);
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          controller.abort();
          void reader.cancel().catch(() => undefined);
          throw new Error(AUTHENTICATION_FAILED);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const payload = record(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    );
    if ('error' in payload || 'error_code' in payload) {
      throw new Error(AUTHENTICATION_FAILED);
    }
    return payload;
  };
  try {
    return await Promise.race([read(), deadline]);
  } catch {
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => undefined);
    } else if (response?.body) {
      void response.body.cancel().catch(() => undefined);
    }
    throw new Error(AUTHENTICATION_FAILED);
  } finally {
    clearTimeout(timer);
  }
}

function googleProfile(payload: Record<string, unknown>): ProviderProfile {
  const email = profileEmail(payload.email);
  const hostedDomain = optionalText(payload.hd, 255);
  return {
    subject: subject(payload.sub),
    email,
    // Third-party Google email can outlive ownership, even if email_verified.
    emailVerified:
      email !== null &&
      payload.email_verified === true &&
      (email.endsWith('@gmail.com') || hostedDomain !== null),
    name: optionalText(payload.name, 255) ?? 'Google user',
  };
}

function kakaoProfile(payload: Record<string, unknown>): ProviderProfile {
  if ('code' in payload) throw new Error(AUTHENTICATION_FAILED);
  const id = payload.id;
  let stableId: string;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
    stableId = String(id);
  } else if (
    typeof id === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(id) &&
    BigInt(id) <= 9_223_372_036_854_775_807n
  ) {
    stableId = id;
  } else {
    throw new Error(AUTHENTICATION_FAILED);
  }
  const account =
    payload.kakao_account == null ? {} : record(payload.kakao_account);
  const profile = account.profile == null ? {} : record(account.profile);
  // Kakao can mask an invalid/expired address; request a fresh email instead.
  const email =
    account.is_email_valid === false ? null : profileEmail(account.email);
  return {
    subject: stableId,
    email,
    emailVerified:
      email !== null &&
      account.is_email_valid === true &&
      account.is_email_verified === true,
    name: optionalText(profile.nickname, 255) ?? 'Kakao user',
  };
}

function naverProfile(payload: Record<string, unknown>): ProviderProfile {
  if (payload.resultcode !== '00') throw new Error(AUTHENTICATION_FAILED);
  const profile = record(payload.response);
  return {
    subject: subject(profile.id),
    email: profileEmail(profile.email),
    // Naver profile email has no authoritative verification attestation.
    emailVerified: false,
    name:
      optionalText(profile.name, 255) ??
      optionalText(profile.nickname, 255) ??
      'Naver user',
  };
}

function requireInput(value: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4096 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new BadRequestException('Invalid social authorization request');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(AUTHENTICATION_FAILED);
  }
  return value as Record<string, unknown>;
}

function subject(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 255 ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new Error(AUTHENTICATION_FAILED);
  }
  return value;
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value == null) return null;
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(AUTHENTICATION_FAILED);
  }
  return value.trim() || null;
}

function profileEmail(value: unknown): string | null {
  const email = optionalText(value, 320)?.toLowerCase() ?? null;
  if (email !== null && !isEmail(email)) {
    throw new Error(AUTHENTICATION_FAILED);
  }
  return email;
}
