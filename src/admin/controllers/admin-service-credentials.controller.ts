import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ServiceCredentialsService } from '../../domain/service-credentials/service-credentials.service';
import {
  CreateServiceCredentialDto,
  UpdateServiceCredentialDto,
} from '../../domain/service-credentials/dto/service-credential.dto';
import { AdminGuard } from '../admin.guard';

@UseGuards(AdminGuard)
@Controller('api/admin/services/:serviceId/credentials')
export class AdminServiceCredentialsController {
  constructor(private readonly credentials: ServiceCredentialsService) {}

  @Post()
  create(
    @Param('serviceId') serviceId: string,
    @Body() body: CreateServiceCredentialDto,
  ) {
    return this.credentials.create(serviceId, body);
  }

  @Get()
  list(@Param('serviceId') serviceId: string) {
    return this.credentials.listByService(serviceId);
  }

  @Patch(':credentialId')
  update(
    @Param('serviceId') serviceId: string,
    @Param('credentialId') credentialId: string,
    @Body() body: UpdateServiceCredentialDto,
  ) {
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
