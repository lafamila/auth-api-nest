import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const BLOCKED_REDIRECT_SCHEMES = new Set([
  'data',
  'file',
  'javascript',
  'vbscript',
]);

const APP_CALLBACK_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*$/;

export function isRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    return false;
  }
  if (
    [...value].some(
      (char) =>
        char.charCodeAt(0) <= 31 ||
        char.charCodeAt(0) === 127 ||
        char.trim() === '',
    )
  ) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const scheme = url.protocol.slice(0, -1);
  if (
    !APP_CALLBACK_SCHEME_PATTERN.test(scheme) ||
    BLOCKED_REDIRECT_SCHEMES.has(scheme.toLowerCase())
  ) {
    return false;
  }
  if (!url.hostname || url.hash) {
    return false;
  }

  return true;
}

export function IsRedirectUri(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isRedirectUri',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isRedirectUri(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be an exact OAuth redirect URI`;
        },
      },
    });
  };
}
