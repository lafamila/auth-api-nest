import { OAuthError } from './oauth-error';
import {
  AUTHENTICATION_METHOD_NOT_ALLOWED,
  AUTHENTICATION_METHOD_REAUTHENTICATION_REQUIRED,
} from './authentication-method';

describe('OAuthError machine-readable policy codes', () => {
  it('preserves the existing response when no code is supplied', () => {
    expect(
      new OAuthError('invalid_grant', 'Invalid code').getResponse(),
    ).toEqual({
      error: 'invalid_grant',
      error_description: 'Invalid code',
    });
  });

  it.each([
    AUTHENTICATION_METHOD_NOT_ALLOWED,
    AUTHENTICATION_METHOD_REAUTHENTICATION_REQUIRED,
  ])('includes %s on a policy 403', (code) => {
    const error = new OAuthError(
      'access_denied',
      'Policy description',
      403,
      code,
    );
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toEqual({
      error: 'access_denied',
      error_description: 'Policy description',
      code,
    });
  });
});
