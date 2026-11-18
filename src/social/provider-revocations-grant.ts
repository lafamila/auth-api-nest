export interface ProviderRevocationGrant {
  provider: string;
  clientId: string;
  subject: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
}

export function validToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 16_384 &&
    /^[A-Za-z0-9._~+/-]+=*$/.test(value)
  );
}

export function tokenExpiry(value: unknown): number | null {
  if (value == null) return null;
  const seconds =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    !Number.isSafeInteger(Date.now() + seconds * 1000)
  ) {
    throw new Error('Invalid provider token expiry');
  }
  return Date.now() + seconds * 1000;
}

export function parseGrant(plaintext: string): ProviderRevocationGrant {
  const value: unknown = JSON.parse(plaintext);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid provider revocation grant');
  }
  const grant = value as ProviderRevocationGrant;
  const keys = [
    'provider',
    'clientId',
    'subject',
    'accessToken',
    'refreshToken',
    'accessTokenExpiresAt',
    'refreshTokenExpiresAt',
  ];
  if (
    Object.keys(grant).length !== keys.length ||
    Object.keys(grant).some((key) => !keys.includes(key)) ||
    !['google', 'kakao', 'naver'].includes(grant.provider) ||
    typeof grant.clientId !== 'string' ||
    !grant.clientId.trim() ||
    grant.clientId.length > 512 ||
    /\p{Cc}/u.test(grant.clientId) ||
    typeof grant.subject !== 'string' ||
    grant.subject.length > 255 ||
    !/^[\x21-\x7e]+$/.test(grant.subject) ||
    ![grant.accessToken, grant.refreshToken].every(
      (token) => token === null || validToken(token),
    ) ||
    ![grant.accessTokenExpiresAt, grant.refreshTokenExpiresAt].every(
      (expiry) =>
        expiry === null ||
        (typeof expiry === 'number' &&
          Number.isSafeInteger(expiry) &&
          expiry >= 0),
    )
  ) {
    throw new Error('Invalid provider revocation grant');
  }
  return grant;
}

export function usableAccess(grant: ProviderRevocationGrant): boolean {
  return (
    !!grant.accessToken &&
    grant.accessTokenExpiresAt !== null &&
    grant.accessTokenExpiresAt > Date.now()
  );
}

export function usableRefresh(grant: ProviderRevocationGrant): boolean {
  return (
    !!grant.refreshToken &&
    (grant.refreshTokenExpiresAt === null ||
      grant.refreshTokenExpiresAt > Date.now())
  );
}
