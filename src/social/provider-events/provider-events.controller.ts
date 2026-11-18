import {
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UnsupportedMediaTypeException,
  UseFilters,
} from '@nestjs/common';
import { Request } from 'express';
import { GoogleEventsVerifier } from './google-events.verifier';
import { GoogleEventsExceptionFilter } from './google-events-exception.filter';
import { ProviderEventsService } from './provider-events.service';
import { ProviderEventsVerifier } from './provider-events.verifier';

@Controller('oauth/events')
export class ProviderEventsController {
  constructor(
    private readonly verifier: ProviderEventsVerifier,
    private readonly google: GoogleEventsVerifier,
    private readonly events: ProviderEventsService,
  ) {}

  @Post('naver')
  @HttpCode(204)
  async naver(@Req() request: Request): Promise<void> {
    requireContentType(request, 'application/x-www-form-urlencoded');
    await this.events.enqueue(this.verifier.naver(request.body));
  }

  @Get('kakao')
  @HttpCode(200)
  async kakaoGet(@Req() request: Request): Promise<void> {
    await this.events.enqueue(
      this.verifier.kakao(request.query, request.headers.authorization),
    );
  }

  @Post('kakao')
  @HttpCode(200)
  async kakaoPost(@Req() request: Request): Promise<void> {
    requireContentType(request, 'application/x-www-form-urlencoded');
    await this.events.enqueue(
      this.verifier.kakao(request.body, request.headers.authorization),
    );
  }

  @Post('google')
  @HttpCode(202)
  @UseFilters(GoogleEventsExceptionFilter)
  async googlePost(@Req() request: Request): Promise<void> {
    requireContentType(request, 'application/secevent+jwt');
    await this.events.enqueue(await this.google.verify(request.body));
  }
}

function requireContentType(request: Request, contentType: string): void {
  if (!request.is(contentType)) throw new UnsupportedMediaTypeException();
}
