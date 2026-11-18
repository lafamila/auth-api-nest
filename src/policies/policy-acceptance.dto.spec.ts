import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { SignupCompleteDto } from '../signup/dto/signup.dto';
import { PolicyAcceptanceDto } from './policy-acceptance.dto';

const agreement = {
  termsAccepted: true,
  privacyAccepted: true,
  termsVersion: '2026-11-18',
  privacyVersion: '2026-11-18',
  policyDigest: 'a'.repeat(64),
};
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

describe('Policy acceptance HTTP DTO', () => {
  it.each([true, 'true'])(
    'accepts explicit JSON/form agreement %j',
    async (value) => {
      await expect(
        pipe.transform(
          { ...agreement, termsAccepted: value, privacyAccepted: value },
          { type: 'body', metatype: PolicyAcceptanceDto },
        ),
      ).resolves.toEqual(agreement);
    },
  );

  it.each([
    'termsAccepted',
    'privacyAccepted',
    'termsVersion',
    'privacyVersion',
    'policyDigest',
  ])('requires %s', async (field) => {
    const input: Record<string, unknown> = { ...agreement };
    delete input[field];
    await expect(
      pipe.transform(input, { type: 'body', metatype: PolicyAcceptanceDto }),
    ).rejects.toThrow(BadRequestException);
  });

  it.each([false, 'false', 'on', 'TRUE', 1, '1', null, '', [], {}])(
    'rejects non-explicit checkbox value %j',
    async (value) => {
      for (const field of ['termsAccepted', 'privacyAccepted']) {
        await expect(
          pipe.transform(
            { ...agreement, [field]: value },
            { type: 'body', metatype: PolicyAcceptanceDto },
          ),
        ).rejects.toThrow(BadRequestException);
      }
    },
  );

  it.each([
    { termsVersion: 'x'.repeat(65) },
    { privacyVersion: 1 },
    { policyDigest: 'a'.repeat(63) },
    { policyDigest: 'a'.repeat(65) },
    { termsUrl: '/terms' },
    { privacyUrl: '/privacy' },
  ])('rejects malformed or extra metadata %j', async (extra) => {
    await expect(
      pipe.transform(
        { ...agreement, ...extra },
        { type: 'body', metatype: PolicyAcceptanceDto },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('inherits the agreement requirement for ordinary signup', async () => {
    const input = {
      loginId: 'user',
      name: 'User',
      email: 'user@example.test',
      code: 'ABC123',
      password: 'Password!123',
    };
    await expect(
      pipe.transform(input, { type: 'body', metatype: SignupCompleteDto }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      pipe.transform(
        { ...input, ...agreement },
        { type: 'body', metatype: SignupCompleteDto },
      ),
    ).resolves.toEqual({ ...input, ...agreement });
  });
});
