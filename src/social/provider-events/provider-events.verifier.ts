import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { TextDecoder } from 'node:util';
import { AppConfigService } from '../../config/app-config.service';
import {
  assertFresh,
  field,
  record,
  VerifiedProviderEvent,
} from './provider-event.types';

const KAKAO_REFERRERS = new Set([
  'ACCOUNT_DELETE',
  'FORCED_ACCOUNT_DELETE',
  'UNLINK_FROM_ADMIN',
  'UNLINK_FROM_APPS',
  'INCOMPLETE_SIGN_UP',
]);

@Injectable()
export class ProviderEventsVerifier {
  constructor(
    private readonly config: AppConfigService,
    private readonly env: ConfigService,
  ) {}

  naver(body: unknown): VerifiedProviderEvent {
    const credentials = this.config.socialProviderCredentials('naver');
    if (!credentials.clientId || !credentials.clientSecret) {
      throw new NotFoundException();
    }
    const input = record(body);
    const clientId = field(input.clientId);
    const encrypted = field(input.encryptUniqueId, 256);
    const timestamp = field(input.timestamp, 16);
    const signature = field(input.signature, 64);
    if (clientId !== credentials.clientId) {
      throw new ForbiddenException('Invalid provider event');
    }
    if (!/^[1-9][0-9]{9,10}$/.test(timestamp)) {
      throw new BadRequestException('Invalid provider event');
    }
    assertFresh(Number(timestamp));
    const key = createHash('md5')
      .update(credentials.clientSecret, 'utf8')
      .digest();
    // Naver signs decoded field values in this exact order, not a JWT or URL-encoded string.
    const canonical = `clientId=${clientId}&encryptUniqueId=${encrypted}&timestamp=${timestamp}`;
    const supplied = decodeBase64Url(signature);
    const expected = createHmac('sha256', key)
      .update(canonical, 'utf8')
      .digest();
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new ForbiddenException('Invalid provider event');
    }
    let subject: string;
    try {
      const ciphertext = decodeBase64Url(encrypted);
      if (ciphertext.length < 32 || ciphertext.length % 16 !== 0) {
        throw new Error('Invalid ciphertext');
      }
      const decipher = createDecipheriv(
        'aes-128-cbc',
        key,
        ciphertext.subarray(0, 16),
      );
      subject = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat([
          decipher.update(ciphertext.subarray(16)),
          decipher.final(),
        ]),
      );
      if (!/^[A-Za-z0-9+/_=-]{1,64}$/.test(subject)) {
        throw new Error('Invalid subject');
      }
    } catch {
      throw new BadRequestException('Invalid provider event');
    }
    return {
      provider: 'naver',
      deduplicationId: canonical,
      targets: [{ clientId, subject, kind: 'unlinked' }],
    };
  }

  kakao(body: unknown, authorization: unknown): VerifiedProviderEvent {
    const clientId = this.config.socialProviderCredentials('kakao').clientId;
    const adminKey = this.env.get<string>('SOCIAL_KAKAO_ADMIN_KEY', '').trim();
    const appId = this.env.get<string>('SOCIAL_KAKAO_APP_ID', '').trim();
    if (!clientId || !adminKey || !/^[1-9][0-9]*$/.test(appId)) {
      throw new NotFoundException();
    }
    if (
      typeof authorization !== 'string' ||
      authorization.length > 4096 ||
      !timingSafeEqual(
        createHash('sha256').update(authorization).digest(),
        createHash('sha256').update(`KakaoAK ${adminKey}`).digest(),
      )
    ) {
      throw new ForbiddenException('Invalid provider event');
    }
    const input = record(body);
    const subject = field(input.user_id, 19);
    const referrer = field(input.referrer_type, 64);
    if (
      field(input.app_id) !== appId ||
      !/^[1-9][0-9]{0,18}$/.test(subject) ||
      BigInt(subject) > 9223372036854775807n ||
      !KAKAO_REFERRERS.has(referrer)
    ) {
      throw new BadRequestException('Invalid provider event');
    }
    // This legacy callback has no signed timestamp/jti; suppress the authenticated tuple for 24h.
    return {
      provider: 'kakao',
      deduplicationId: JSON.stringify([appId, subject, referrer]),
      targets: [{ clientId, subject, kind: 'unlinked' }],
    };
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new BadRequestException('Invalid provider event');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new BadRequestException('Invalid provider event');
  }
  return decoded;
}
