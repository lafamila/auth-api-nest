import { HttpException } from '@nestjs/common';

export class OAuthError extends HttpException {
  constructor(
    public readonly error: string,
    public readonly errorDescription: string,
    public readonly statusCode = 400,
  ) {
    super({ error, error_description: errorDescription }, statusCode);
  }
}
