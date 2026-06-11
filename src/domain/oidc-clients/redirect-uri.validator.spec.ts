import { validate } from 'class-validator';
import { CreateOidcClientDto } from './dto/oidc-client.dto';
import { isRedirectUri } from './redirect-uri.validator';

describe('redirect URI validation', () => {
  it('accepts body-lab native callback schemes', async () => {
    const dto = Object.assign(new CreateOidcClientDto(), {
      clientId: 'body-lab-ios',
      clientType: 'public',
      redirectUris: ['bodylab://auth/callback', 'bodylab-mac://auth/callback'],
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('rejects unsafe redirect URI values', () => {
    expect(isRedirectUri('javascript://auth/callback')).toBe(false);
    expect(isRedirectUri('data://auth/callback')).toBe(false);
    expect(isRedirectUri('bodylab://auth/callback#fragment')).toBe(false);
    expect(isRedirectUri('bodylab auth callback')).toBe(false);
  });
});
