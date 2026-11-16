import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  PortalEmailCompleteDto,
  PortalEmailStartDto,
  PortalPasswordDto,
} from './portal-profile.dto';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

const emailInput = {
  email: ' New@Example.test ',
  currentPassword: ' Password!1 ',
};
const completeInput = {
  verificationId: '7819567a-f64a-46f5-8595-8b47c4b27a96',
  code: 'ABC234',
};
const passwordInput = {
  password: ' Password!1 ',
  passwordConfirm: ' Password!1 ',
};

describe('Portal profile DTO boundaries', () => {
  it('normalizes email but preserves the current password exactly', async () => {
    await expect(
      pipe.transform(emailInput, {
        type: 'body',
        metatype: PortalEmailStartDto,
      }),
    ).resolves.toEqual({
      email: 'new@example.test',
      currentPassword: ' Password!1 ',
    });
  });

  it('trims an optional login ID without trimming any password', async () => {
    await expect(
      pipe.transform(
        {
          ...passwordInput,
          loginId: ' New-ID ',
          currentPassword: ' Current!1 ',
        },
        { type: 'body', metatype: PortalPasswordDto },
      ),
    ).resolves.toEqual({
      ...passwordInput,
      loginId: 'New-ID',
      currentPassword: ' Current!1 ',
    });
  });

  it('allows absent optional password fields for social-only registration', async () => {
    await expect(
      pipe.transform(passwordInput, {
        type: 'body',
        metatype: PortalPasswordDto,
      }),
    ).resolves.toMatchObject(passwordInput);
  });

  it.each([
    [PortalEmailStartDto, emailInput],
    [PortalEmailCompleteDto, completeInput],
    [PortalPasswordDto, passwordInput],
  ])('rejects immutable and unknown fields for %p', async (metatype, input) => {
    for (const key of [
      'id',
      'accountId',
      'name',
      'credentialVersion',
      'unknown',
    ]) {
      await expect(
        pipe.transform(
          { ...input, [key]: 'override' },
          { type: 'body', metatype },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('rejects email in confirmation and password payloads', async () => {
    for (const [metatype, input] of [
      [PortalEmailCompleteDto, completeInput],
      [PortalPasswordDto, passwordInput],
    ] as const) {
      await expect(
        pipe.transform(
          { ...input, email: 'injected@example.test' },
          { type: 'body', metatype },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it.each([
    {},
    { ...emailInput, email: 'invalid' },
    { ...emailInput, email: null },
    { ...emailInput, currentPassword: '' },
    { ...emailInput, currentPassword: null },
  ])('rejects invalid email-start payloads: %j', async (input) => {
    await expect(
      pipe.transform(input, { type: 'body', metatype: PortalEmailStartDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    {},
    { ...completeInput, verificationId: 'not-a-uuid' },
    { ...completeInput, code: '12345' },
    { ...completeInput, code: 'ABC2345' },
    { ...completeInput, code: 'ABC!23' },
    { ...completeInput, code: null },
  ])('rejects invalid email confirmations: %j', async (input) => {
    await expect(
      pipe.transform(input, { type: 'body', metatype: PortalEmailCompleteDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    {},
    { ...passwordInput, password: 'short!' },
    { ...passwordInput, passwordConfirm: null },
    { ...passwordInput, loginId: null },
    { ...passwordInput, loginId: '  ' },
    { ...passwordInput, loginId: 123 },
    { ...passwordInput, currentPassword: null },
    { ...passwordInput, currentPassword: '' },
    { ...passwordInput, currentPassword: false },
  ])(
    'rejects invalid password payloads, including explicit null optionals: %j',
    async (input) => {
      await expect(
        pipe.transform(input, { type: 'body', metatype: PortalPasswordDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});
