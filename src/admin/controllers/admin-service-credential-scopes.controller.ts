import { Controller, Get, UseGuards } from '@nestjs/common';
import { SERVICE_CREDENTIAL_SCOPE_DEFINITIONS } from '../../database/entities/service-credential.entity';
import { AdminGuard } from '../admin.guard';

@UseGuards(AdminGuard)
@Controller('api/admin/service-credential-scopes')
export class AdminServiceCredentialScopesController {
  @Get()
  list() {
    return SERVICE_CREDENTIAL_SCOPE_DEFINITIONS;
  }
}
