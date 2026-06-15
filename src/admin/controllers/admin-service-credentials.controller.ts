import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ServiceCredentialsService } from '../../domain/service-credentials/service-credentials.service';
import {
  CreateServiceCredentialDto,
  UpdateServiceCredentialDto,
} from '../../domain/service-credentials/dto/service-credential.dto';
import { AdminGuard } from '../admin.guard';
import { ServiceOnboardingService } from '../../domain/service-onboarding/service-onboarding.service';

@UseGuards(AdminGuard)
@Controller('api/admin/services/:serviceId/credentials')
export class AdminServiceCredentialsController {
  constructor(
    private readonly credentials: ServiceCredentialsService,
    private readonly onboarding: ServiceOnboardingService,
  ) {}

  @Post()
  async create(
    @Param('serviceId') serviceId: string,
    @Body() body: CreateServiceCredentialDto,
  ) {
    await this.onboarding.assertManualCoreSpecEditAllowed(serviceId);
    return this.credentials.create(serviceId, body);
  }

  @Get()
  list(@Param('serviceId') serviceId: string) {
    return this.credentials.listByService(serviceId);
  }

  @Patch(':credentialId')
  async update(
    @Param('serviceId') serviceId: string,
    @Param('credentialId') credentialId: string,
    @Body() body: UpdateServiceCredentialDto,
  ) {
    if (body.scopes !== undefined) {
      await this.onboarding.assertManualCoreSpecEditAllowed(serviceId);
    }
    return this.credentials.update(serviceId, credentialId, body);
  }

  @Post(':credentialId/rotate')
  rotate(
    @Param('serviceId') serviceId: string,
    @Param('credentialId') credentialId: string,
  ) {
    return this.credentials.rotate(serviceId, credentialId);
  }

  @Post(':credentialId/disable')
  disable(
    @Param('serviceId') serviceId: string,
    @Param('credentialId') credentialId: string,
  ) {
    return this.credentials.disable(serviceId, credentialId);
  }
}
