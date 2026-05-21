import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import {
  CreateOidcClientDto,
  RotateClientSecretDto,
  UpdateOidcClientDto,
} from '../../domain/oidc-clients/dto/oidc-client.dto';
import { OidcClientsService } from '../../domain/oidc-clients/oidc-clients.service';

@UseGuards(AdminGuard)
@Controller('api/admin/services/:serviceId/clients')
export class AdminClientsController {
  constructor(private readonly clients: OidcClientsService) {}

  @Post()
  create(
    @Param('serviceId') serviceId: string,
    @Body() body: CreateOidcClientDto,
  ) {
    return this.clients.create(serviceId, body);
  }

  @Get()
  list(@Param('serviceId') serviceId: string) {
    return this.clients.listByService(serviceId);
  }

  @Patch(':clientId')
  update(
    @Param('serviceId') serviceId: string,
    @Param('clientId') clientId: string,
    @Body() body: UpdateOidcClientDto,
  ) {
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
