import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import { OidcClientsService } from '../../domain/oidc-clients/oidc-clients.service';

@UseGuards(AdminGuard)
@Controller('api/admin/services/:serviceId/clients')
export class AdminClientsController {
  constructor(private readonly clients: OidcClientsService) {}

  @Get()
  list(@Param('serviceId') serviceId: string) {
    return this.clients.listByService(serviceId);
  }
}
