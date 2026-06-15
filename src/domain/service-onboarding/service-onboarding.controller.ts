import { Body, Controller, Headers, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import {
  CreateServiceOnboardingRequestDto,
  UpdateServiceOnboardingRequestDto,
} from './dto/service-onboarding.dto';
import { ServiceOnboardingService } from './service-onboarding.service';

@Controller('api/service-onboarding-requests')
export class ServiceOnboardingController {
  constructor(private readonly onboarding: ServiceOnboardingService) {}

  @Post()
  create(@Body() body: CreateServiceOnboardingRequestDto, @Req() request: Request) {
    return this.onboarding.create(body, this.ipAddress(request));
  }

  @Post(':requestId/update')
  update(
    @Param('requestId') requestId: string,
    @Body() body: UpdateServiceOnboardingRequestDto,
    @Req() request: Request,
    @Headers('x-request-secret') requestSecret?: string,
  ) {
    return this.onboarding.update(
      requestId,
      body,
      this.ipAddress(request),
      requestSecret,
    );
  }

  private ipAddress(request: Request): string | null {
    const forwarded = request.header('x-forwarded-for')?.split(',')[0]?.trim();
    return forwarded || request.ip || null;
  }
}
