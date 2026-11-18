export const AUTHENTICATION_METHODS = [
  'local',
  'google',
  'kakao',
  'naver',
  'legacy',
] as const;
export type AuthenticationMethod = (typeof AUTHENTICATION_METHODS)[number];
export const AUTHENTICATION_METHOD_CLAIM =
  'https://lafamila.xyz/claims/authentication_method';
export const SERVICE_CATEGORY_CLAIM =
  'https://lafamila.xyz/claims/service_category';
export const KAKAO_GAME_DENIED_MESSAGE =
  '카카오로 로그인한 경우 정책상 게임서비스는 이용할 수 없습니다. 다른 방식으로 로그인해주세요.';
export const AUTHENTICATION_METHOD_REQUIRED_MESSAGE =
  '로그인 방식을 확인할 수 없습니다. 다시 로그인해주세요.';
export const AUTHENTICATION_METHOD_NOT_ALLOWED =
  'AUTHENTICATION_METHOD_NOT_ALLOWED';
export const AUTHENTICATION_METHOD_REAUTHENTICATION_REQUIRED =
  'AUTHENTICATION_METHOD_REAUTHENTICATION_REQUIRED';

export function gameLoginPolicyCode(method: unknown): string | undefined {
  const normalized = authenticationMethod(method);
  if (normalized === 'kakao') return AUTHENTICATION_METHOD_NOT_ALLOWED;
  if (normalized === 'legacy')
    return AUTHENTICATION_METHOD_REAUTHENTICATION_REQUIRED;
  return undefined;
}

export function authenticationMethod(value: unknown): AuthenticationMethod {
  return typeof value === 'string' &&
    (AUTHENTICATION_METHODS as readonly string[]).includes(value)
    ? (value as AuthenticationMethod)
    : 'legacy';
}

export function gameLoginDenial(
  category: string | undefined,
  method: AuthenticationMethod,
): string | null {
  method = authenticationMethod(method);
  if (category !== 'game') return null;
  if (method === 'kakao') return KAKAO_GAME_DENIED_MESSAGE;
  if (method === 'legacy') return AUTHENTICATION_METHOD_REQUIRED_MESSAGE;
  return null;
}
