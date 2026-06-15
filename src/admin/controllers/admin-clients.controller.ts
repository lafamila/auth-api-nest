import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import {
  CreateOidcClientDto,
  RotateClientSecretDto,
  UpdateOidcClientDto,
} from '../../domain/oidc-clients/dto/oidc-client.dto';
import { OidcClientsService } from '../../domain/oidc-clients/oidc-clients.service';
import { ServiceOnboardingService } from '../../domain/service-onboarding/service-onboarding.service';

@UseGuards(AdminGuard)
@Controller('api/admin/services/:serviceId/clients')
export class AdminClientsController {
  constructor(
    private readonly clients: OidcClientsService,
    private readonly onboarding: ServiceOnboardingService,
  ) {}

  @Post()
  async create(
    @Param('serviceId') serviceId: string,
    @Body() body: CreateOidcClientDto,
  ) {
    await this.onboarding.assertManualCoreSpecEditAllowed(serviceId);
    return this.clients.create(serviceId, body);
  }

  @Get()
  list(@Param('serviceId') serviceId: string) {
    return this.clients.listByService(serviceId);
  }

  @Patch(':clientId')
  async update(
    @Param('serviceId') serviceId: string,
    @Param('clientId') clientId: string,
    @Body() body: UpdateOidcClientDto,
  ) {
    await this.onboarding.assertManualCoreSpecEditAllowed(serviceId);
    return this.clients.update(serviceId, clientId, body);
  }

  @Post(':clientId/rotate-secret')
  async rotateSecret(
    @Param('serviceId') serviceId: string,
    @Param('clientId') clientId: string,
    @Body() body: RotateClientSecretDto,
  ) {
    await this.clients.rotateSecret(serviceId, clientId, body);
    return { ok: true };
  }
}
