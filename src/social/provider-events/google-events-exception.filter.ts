import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  UnauthorizedException,
} from '@nestjs/common';
import { Response } from 'express';

@Catch(BadRequestException, UnauthorizedException)
export class GoogleEventsExceptionFilter implements ExceptionFilter {
  catch(
    exception: BadRequestException | UnauthorizedException,
    host: ArgumentsHost,
  ): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(400)
      .set('Content-Language', 'en')
      .json({
        err:
          exception instanceof UnauthorizedException
            ? 'authentication_failed'
            : 'invalid_request',
        description: 'Security event validation failed',
      });
  }
}
