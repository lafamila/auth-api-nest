import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { SocialCompleteDto } from './social-login.dto';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

const signupInput = {
  termsAccepted: true,
  privacyAccepted: true,
  termsVersion: '2026-11-18',
  privacyVersion: '2026-11-18',
  policyDigest: 'a'.repeat(64),
  transaction: 'social-transaction',
  email: 'social@example.test',
  name: 'Social User',
};

describe('Social signup DTO boundary', () => {
  it.each([
    'termsAccepted',
    'privacyAccepted',
    'termsVersion',
    'privacyVersion',
    'policyDigest',
  ])('requires the %s agreement field', async (field) => {
    const input: Record<string, unknown> = { ...signupInput };
    delete input[field];
    await expect(
      pipe.transform(input, { type: 'body', metatype: SocialCompleteDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([false, 'false', 'on', 1, null])(
    'rejects implicit agreement %j',
    async (value) => {
      for (const field of ['termsAccepted', 'privacyAccepted']) {
        await expect(
          pipe.transform(
            { ...signupInput, [field]: value },
            { type: 'body', metatype: SocialCompleteDto },
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    },
  );

  it('accepts explicit native form checkbox values', async () => {
    await expect(
      pipe.transform(
        { ...signupInput, termsAccepted: 'true', privacyAccepted: 'true' },
        { type: 'body', metatype: SocialCompleteDto },
      ),
    ).resolves.toEqual(signupInput);
  });
  it('accepts social-only completion without local credentials', async () => {
    await expect(
      pipe.transform(signupInput, {
        type: 'body',
        metatype: SocialCompleteDto,
      }),
    ).resolves.toEqual(signupInput);
  });

  it.each(['loginId', 'password', 'passwordConfirm'])(
    'rejects the literal %s field regardless of its value',
    async (field) => {
      for (const value of [
        'Local-password!1',
        '',
        '  ',
        null,
        undefined,
        0,
        false,
        [],
      ]) {
        await expect(
          pipe.transform(
            { ...signupInput, [field]: value },
            { type: 'body', metatype: SocialCompleteDto },
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    },
  );

  it('rejects a complete matching credential pair instead of silently stripping it', async () => {
    await expect(
      pipe.transform(
        {
          ...signupInput,
          loginId: 'local-user',
          password: 'Local-password!1',
          passwordConfirm: 'Local-password!1',
        },
        { type: 'body', metatype: SocialCompleteDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    { transaction: '' },
    { email: 'not-an-email' },
    { name: '' },
    { unknown: 'override' },
  ])('preserves completion validation for %j', async (fields) => {
    await expect(
      pipe.transform(
        { ...signupInput, ...fields },
        { type: 'body', metatype: SocialCompleteDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
