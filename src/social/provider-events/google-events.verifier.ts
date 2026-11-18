import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, JsonWebKey, KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AppConfigService } from '../../config/app-config.service';
import {
  assertFresh,
  CLOCK_SKEW_SECONDS,
  field,
  ProviderEventTarget,
  record,
  VerifiedProviderEvent,
} from './provider-event.types';

// Pinned to Google's public RISC discovery, not to any incoming JWT URL/header.
export const GOOGLE_RISC_ISSUER = 'https://accounts.google.com';
export const GOOGLE_RISC_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const RISC = 'https://schemas.openid.net/secevent/risc/event-type/';
export const GOOGLE_EVENT_KINDS = new Map<string, ProviderEventTarget['kind']>([
  [`${RISC}sessions-revoked`, 'sessions_revoked'],
  [
    'https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked',
    'sessions_revoked',
  ],
  [`${RISC}account-disabled`, 'sessions_revoked'],
  [`${RISC}account-credential-change-required`, 'sessions_revoked'],
]);
const SUBJECT_ISSUERS = new Set([
  GOOGLE_RISC_ISSUER,
  `${GOOGLE_RISC_ISSUER}/`,
  'accounts.google.com',
]);

@Injectable()
export class GoogleEventsVerifier {
  private keys = new Map<string, KeyObject>();
  private expiresAt = 0;
  private nextRefreshAt = 0;
  private refreshFailed = false;
  private refreshing?: Promise<void>;

  constructor(
    private readonly config: AppConfigService,
    private readonly env: ConfigService,
  ) {}

  get googleEventsEnabled(): boolean {
    const { clientId, clientSecret } =
      this.config.socialProviderCredentials('google');
    return (
      this.env.get<string>('SOCIAL_GOOGLE_EVENTS_ENABLED', 'false') ===
        'true' &&
      /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) &&
      !!clientSecret
    );
  }

  async verify(body: unknown): Promise<VerifiedProviderEvent> {
    if (!this.googleEventsEnabled) throw new NotFoundException();
    const token = field(body, 64 * 1024).trim();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw new BadRequestException('Invalid security event token');
    }
    let header: jwt.JwtHeader;
    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded) throw new Error();
      header = decoded.header;
      if (
        header.alg !== 'RS256' ||
        !['secevent+jwt', 'application/secevent+jwt'].includes(
          header.typ ?? '',
        ) ||
        typeof header.kid !== 'string' ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(header.kid) ||
        ['jku', 'jwk', 'x5u', 'x5c', 'crit'].some((name) => name in header)
      )
        throw new Error();
    } catch {
      throw new BadRequestException('Invalid security event token');
    }
    const key = await this.keyFor(header.kid);
    const clientId = this.config.socialProviderCredentials('google').clientId;
    let claims: jwt.JwtPayload;
    try {
      const verified = jwt.verify(token, key, {
        algorithms: ['RS256'],
        issuer: [GOOGLE_RISC_ISSUER, `${GOOGLE_RISC_ISSUER}/`],
        audience: clientId,
        ignoreExpiration: true,
        clockTolerance: CLOCK_SKEW_SECONDS,
      });
      if (typeof verified === 'string') throw new Error();
      claims = verified;
    } catch {
      throw new UnauthorizedException('Invalid security event token');
    }
    // SETs describe historical events, not expiring credentials. Bound receipt age
    // separately, allowing absent exp rather than requiring an ID-token claim set.
    assertFresh(claims.iat!);
    if (claims.exp !== undefined && !Number.isSafeInteger(claims.exp)) {
      throw new BadRequestException('Invalid security event token');
    }
    const jti = field(claims.jti);
    const events = Object.entries(record(claims.events));
    if (events.length === 0 || events.length > 16) {
      throw new BadRequestException('Invalid security event token');
    }
    const targets: ProviderEventTarget[] = [];
    for (const [type, value] of events) {
      const kind = GOOGLE_EVENT_KINDS.get(type);
      // Unknown events (including verification) are authenticated, deduplicated
      // and ACKed without storing their data or changing an account.
      if (!kind) continue;
      const subject = record(record(value).subject);
      if (
        !['iss-sub', 'iss_sub', 'id_token_claims'].includes(
          field(subject.subject_type, 32),
        ) ||
        !SUBJECT_ISSUERS.has(field(subject.iss))
      )
        throw new BadRequestException('Invalid security event subject');
      const sub = field(subject.sub, 255);
      if (!/^[A-Za-z0-9_-]+$/.test(sub)) {
        throw new BadRequestException('Invalid security event subject');
      }
      if (
        !targets.some(
          (target) => target.subject === sub && target.kind === kind,
        )
      ) {
        targets.push({ clientId, subject: sub, kind });
      }
    }
    return {
      provider: 'google',
      deduplicationId: JSON.stringify([GOOGLE_RISC_ISSUER, clientId, jti]),
      targets,
    };
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    if (this.keys.has(kid) && Date.now() < this.expiresAt)
      return this.keys.get(kid)!;
    if (!this.refreshing && Date.now() >= this.nextRefreshAt) {
      this.nextRefreshAt = Date.now() + 30_000;
      this.refreshing = this.refreshKeys().finally(() => {
        this.refreshing = undefined;
      });
    }
    await this.refreshing;
    if (this.refreshFailed) {
      throw new ServiceUnavailableException(
        'Security event signing keys unavailable',
      );
    }
    const key = this.keys.get(kid);
    if (!key || Date.now() >= this.expiresAt) {
      throw new UnauthorizedException('Unknown security event signing key');
    }
    return key;
  }

  private async refreshKeys(): Promise<void> {
    try {
      const response = await fetch(GOOGLE_RISC_JWKS, {
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 64 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const data = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!Array.isArray(data.keys) || data.keys.length > 20) throw new Error();
      const keys = new Map<string, KeyObject>();
      for (const value of data.keys) {
        const jwk = record(value);
        if (
          jwk.kty !== 'RSA' ||
          jwk.alg !== 'RS256' ||
          jwk.use !== 'sig' ||
          typeof jwk.kid !== 'string' ||
          typeof jwk.n !== 'string' ||
          typeof jwk.e !== 'string' ||
          'd' in jwk ||
          keys.has(jwk.kid)
        )
          continue;
        const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
        if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
        keys.set(jwk.kid, key);
      }
      if (!keys.size) throw new Error();
      this.keys = keys;
      this.refreshFailed = false;
      const cacheSeconds = Number(
        /(?:^|,)\s*max-age=(\d+)/i.exec(
          response.headers.get('cache-control') ?? '',
        )?.[1] ?? 300,
      );
      this.expiresAt =
        Date.now() + Math.max(60, Math.min(cacheSeconds, 3600)) * 1000;
    } catch {
      this.refreshFailed = true;
      throw new ServiceUnavailableException(
        'Security event signing keys unavailable',
      );
    }
  }
}
