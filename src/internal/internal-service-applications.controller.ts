import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ServiceApplicationsService } from '../domain/service-applications/service-applications.service';
import { ServiceCredentialsService } from '../domain/service-credentials/service-credentials.service';
import { ServiceCredentialRequest } from '../domain/service-credentials/service-credential-request';
import { InternalServiceCredentialsGuard } from './internal-service-credentials.guard';

@UseGuards(InternalServiceCredentialsGuard)
@Controller('api/internal/service-applications')
export class InternalServiceApplicationsController {
  constructor(
    private readonly applications: ServiceApplicationsService,
    private readonly credentials: ServiceCredentialsService,
  ) {}

  @Get('status')
  status(
    @Query('serviceKey') serviceKey: string | undefined,
    @Query('accountId') accountId: string | undefined,
    @Req() request: ServiceCredentialRequest,
  ) {
    const credential = request.serviceCredential;
    if (!credential) {
      throw new UnauthorizedException('Service credential context is required');
    }
    if (!this.credentials.hasScope(credential, 'permission.read')) {
      throw new ForbiddenException('Service credential is missing permission.read');
    }
    if (!serviceKey || !accountId) {
      throw new ForbiddenException('serviceKey and accountId are required');
    }
    if (credential.serviceKey !== serviceKey) {
      throw new ForbiddenException('Service credential does not match serviceKey');
    }
    return this.applications.statusForServiceAccount(serviceKey, accountId);
  }
}
