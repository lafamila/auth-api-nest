import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ServiceCredentialsService } from '../../domain/service-credentials/service-credentials.service';
import { AdminGuard } from '../admin.guard';

@UseGuards(AdminGuard)
@Controller('api/admin/services/:serviceId/credentials')
export class AdminServiceCredentialsController {
  constructor(private readonly credentials: ServiceCredentialsService) {}

  @Get()
  list(@Param('serviceId') serviceId: string) {
    return this.credentials.listByService(serviceId);
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
