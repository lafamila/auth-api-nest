import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ServiceOnboardingService } from '../../domain/service-onboarding/service-onboarding.service';
import {
  ListServiceOnboardingRequestsDto,
  RejectServiceOnboardingRequestDto,
} from '../../domain/service-onboarding/dto/service-onboarding.dto';
import { AdminGuard } from '../admin.guard';

type AdminRequest = Request & {
  adminAccount?: { id: string };
};

@UseGuards(AdminGuard)
@Controller('api/admin/service-onboarding-requests')
export class AdminServiceOnboardingController {
  constructor(private readonly onboarding: ServiceOnboardingService) {}

  @Get()
  list(@Query() query: ListServiceOnboardingRequestsDto) {
    return this.onboarding.list(query.status);
  }

  @Get(':requestId')
  get(@Param('requestId') requestId: string) {
    return this.onboarding.get(requestId);
  }

  @Post(':requestId/approve')
  approve(@Param('requestId') requestId: string, @Req() request: AdminRequest) {
    return this.onboarding.approve(requestId, request.adminAccount!.id);
  }

  @Post(':requestId/reject')
  reject(
    @Param('requestId') requestId: string,
    @Body() body: RejectServiceOnboardingRequestDto,
    @Req() request: AdminRequest,
  ) {
    return this.onboarding.reject(requestId, request.adminAccount!.id, body);
  }
}
