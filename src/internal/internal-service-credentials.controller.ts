import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ServiceCredentialsService } from '../domain/service-credentials/service-credentials.service';
import { ServiceCredentialRequest } from '../domain/service-credentials/service-credential-request';
import { ServiceCredentialVerificationResult } from '../domain/service-credentials/service-credential-verification';
import { InternalServiceCredentialVerifyDto } from './dto/internal-service-credential-verify.dto';
import { InternalServiceCredentialsGuard } from './internal-service-credentials.guard';

@UseGuards(InternalServiceCredentialsGuard)
@Controller('api/internal/service-credentials')
export class InternalServiceCredentialsController {
  constructor(private readonly credentials: ServiceCredentialsService) {}

  /**
   * 호출자가 "제3자에게 제시받은" credential 의 유효성을 auth 에 물어보는 창구.
   * 유효/무효 모두 200 으로 답하고 판정은 `valid` 로 전달한다.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verify(
    @Body() body: InternalServiceCredentialVerifyDto,
    @Req() request: ServiceCredentialRequest,
  ): Promise<ServiceCredentialVerificationResult> {
    const caller = request.serviceCredential;
    if (!caller) {
      throw new UnauthorizedException('Service credential context is required');
    }
    return this.credentials.verifyPresented(body.keyId, body.secret, {
      caller,
      requiredScope: body.requiredScope,
      ipAddress: this.resolveRemoteAddress(request),
      userAgent: request.header('user-agent') ?? null,
    });
  }

  private resolveRemoteAddress(request: Request): string | null {
    const forwarded = request.header('x-forwarded-for')?.split(',')[0]?.trim();
    return forwarded || request.ip || request.socket.remoteAddress || null;
  }
}
