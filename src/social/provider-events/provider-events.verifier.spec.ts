import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigService } from '../../config/app-config.service';
import { ProviderEventsVerifier } from './provider-events.verifier';

export const NAVER_VECTOR = {
  clientId: 'naver-test-client',
  encryptUniqueId:
    'AAECAwQFBgcICQoLDA0OD-pyo_MysNITfq9dkdcDKGMXV4Y89fXpP_aCJKn2qbd2',
  timestamp: '1794960000',
  signature: 'tmtau7HYgPmicWsR2BYcabllES8yIEzcELv1d4ac-ug',
};

export function fixture(overrides: Record<string, string> = {}) {
  const env = new ConfigService({
    NODE_ENV: 'test',
    ADMIN_OTP_ENCRYPTION_KEY: 'unit-test-only-key',
    SOCIAL_NAVER_CLIENT_ID: 'naver-test-client',
    SOCIAL_NAVER_CLIENT_SECRET: 'naver-test-client-secret',
    SOCIAL_KAKAO_CLIENT_ID: 'kakao-test-client',
    SOCIAL_KAKAO_ADMIN_KEY: 'kakao-test-admin-key',
    SOCIAL_KAKAO_APP_ID: '123456',
    SOCIAL_GOOGLE_CLIENT_ID: 'unit-test.apps.googleusercontent.com',
    SOCIAL_GOOGLE_CLIENT_SECRET: 'google-test-secret',
    ...overrides,
  });
  return { env, config: new AppConfigService(env) };
}

describe('ProviderEventsVerifier', () => {
  let verifier: ProviderEventsVerifier;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(1794960030 * 1000);
    const { config, env } = fixture();
    verifier = new ProviderEventsVerifier(config, env);
  });
  afterEach(() => jest.useRealTimers());

  it('decodes the independent fixed Naver MD5/AES128CBC/HMAC-SHA256 vector', () => {
    // Secret: naver-test-client-secret, MD5 key: 0b084b4f341f25c1172f4b319dc471f0.
    // IV: 000102030405060708090a0b0c0d0e0f, checked independently with OpenSSL.
    expect(verifier.naver(NAVER_VECTOR)).toEqual({
      provider: 'naver',
      deduplicationId: `clientId=${NAVER_VECTOR.clientId}&encryptUniqueId=${NAVER_VECTOR.encryptUniqueId}&timestamp=${NAVER_VECTOR.timestamp}`,
      targets: [
        {
          clientId: NAVER_VECTOR.clientId,
          subject: 'SOME_NAVER_LOGIN_UNIQUE_ID',
          kind: 'unlinked',
        },
      ],
    });
  });

  it.each(['signature', 'encryptUniqueId'] as const)(
    'rejects a forged Naver %s before any target is trusted',
    (name) => {
      expect(() =>
        verifier.naver({ ...NAVER_VECTOR, [name]: 'A'.repeat(43) }),
      ).toThrow(ForbiddenException);
    },
  );

  it('rejects another Naver client and a wrong secret', () => {
    expect(() =>
      verifier.naver({ ...NAVER_VECTOR, clientId: 'wrong' }),
    ).toThrow(ForbiddenException);
    const { config, env } = fixture({ SOCIAL_NAVER_CLIENT_SECRET: 'wrong' });
    expect(() =>
      new ProviderEventsVerifier(config, env).naver(NAVER_VECTOR),
    ).toThrow(ForbiddenException);
  });

  it.each([-86_401_000, 61_000])(
    'rejects Naver timestamps outside the receipt window (%i)',
    (offset) => {
      jest.setSystemTime(1794960000 * 1000 - offset);
      expect(() => verifier.naver(NAVER_VECTOR)).toThrow(UnauthorizedException);
    },
  );

  it('does not reopen a future-skewed Naver event after its 24h dedup receipt expires', () => {
    const firstReceipt = 1794960000 - 60;
    jest.setSystemTime(firstReceipt * 1000);
    expect(verifier.naver(NAVER_VECTOR).provider).toBe('naver');
    jest.setSystemTime((firstReceipt + 86_400) * 1000);
    expect(() => verifier.naver(NAVER_VECTOR)).toThrow(UnauthorizedException);
  });

  it.each([
    undefined,
    [],
    'not-a-form',
    { ...NAVER_VECTOR, clientId: ['naver-test-client'] },
    { ...NAVER_VECTOR, timestamp: 1794960000 },
    { ...NAVER_VECTOR, timestamp: '1.79496e9' },
  ])('rejects non-scalar/missing Naver form fields', (input) => {
    expect(() => verifier.naver(input)).toThrow(BadRequestException);
  });

  it.each(['SOCIAL_NAVER_CLIENT_ID', 'SOCIAL_NAVER_CLIENT_SECRET'])(
    'keeps Naver off without %s',
    (name) => {
      const { config, env } = fixture({ [name]: '' });
      expect(() =>
        new ProviderEventsVerifier(config, env).naver(NAVER_VECTOR),
      ).toThrow(NotFoundException);
    },
  );

  const kakao = {
    app_id: '123456',
    user_id: '9223372036854775807',
    referrer_type: 'UNLINK_FROM_APPS',
  };
  const auth = 'KakaoAK kakao-test-admin-key';
  it.each([
    'ACCOUNT_DELETE',
    'FORCED_ACCOUNT_DELETE',
    'UNLINK_FROM_ADMIN',
    'UNLINK_FROM_APPS',
    'INCOMPLETE_SIGN_UP',
  ])(
    'accepts Kakao referrer %s without coercing the int64 subject',
    (referrer) => {
      expect(
        verifier.kakao({ ...kakao, referrer_type: referrer }, auth).targets,
      ).toEqual([
        {
          clientId: 'kakao-test-client',
          subject: kakao.user_id,
          kind: 'unlinked',
        },
      ]);
    },
  );
  it.each([
    '0',
    '-1',
    '01',
    '1e3',
    '1.0',
    '9223372036854775808',
    'user@example.test',
    123,
    ['123'],
  ])('rejects invalid Kakao user_id %s', (id) => {
    expect(() => verifier.kakao({ ...kakao, user_id: id }, auth)).toThrow(
      BadRequestException,
    );
  });
  it.each([
    undefined,
    '',
    'Bearer kakao-test-admin-key',
    'KakaoAK wrong',
    ['KakaoAK kakao-test-admin-key'],
  ])('rejects forged Kakao authorization', (value) => {
    expect(() => verifier.kakao(kakao, value)).toThrow(ForbiddenException);
  });
  it('rejects the wrong app, unknown referrers and duplicate fields', () => {
    expect(() => verifier.kakao({ ...kakao, app_id: '654321' }, auth)).toThrow(
      BadRequestException,
    );
    expect(() =>
      verifier.kakao({ ...kakao, referrer_type: 'UNKNOWN' }, auth),
    ).toThrow(BadRequestException);
    expect(() =>
      verifier.kakao({ ...kakao, app_id: ['123456'] }, auth),
    ).toThrow(BadRequestException);
  });
  it.each([
    'SOCIAL_KAKAO_APP_ID',
    'SOCIAL_KAKAO_ADMIN_KEY',
    'SOCIAL_KAKAO_CLIENT_ID',
  ])('keeps Kakao off without %s', (name) => {
    const { config, env } = fixture({ [name]: '' });
    expect(() =>
      new ProviderEventsVerifier(config, env).kakao(kakao, auth),
    ).toThrow(NotFoundException);
  });
});
