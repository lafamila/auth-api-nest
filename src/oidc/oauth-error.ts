import { HttpException } from '@nestjs/common';

export class OAuthError extends HttpException {
  constructor(
    public readonly error: string,
    public readonly errorDescription: string,
    public readonly statusCode = 400,
    public readonly code?: string,
  ) {
    super(
      { error, error_description: errorDescription, ...(code ? { code } : {}) },
      statusCode,
    );
  }
}
