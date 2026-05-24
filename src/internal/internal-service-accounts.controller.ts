import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AccountsService } from '../domain/accounts/accounts.service';
import { ServiceCredentialsService } from '../domain/service-credentials/service-credentials.service';
import { ServiceCredentialRequest } from '../domain/service-credentials/service-credential-request';
import { InternalServiceAccountSearchQueryDto } from './dto/internal-service-account-search.dto';
import { InternalServiceCredentialsGuard } from './internal-service-credentials.guard';

@UseGuards(InternalServiceCredentialsGuard)
@Controller('api/internal/service-accounts')
export class InternalServiceAccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly credentials: ServiceCredentialsService,
  ) {}

  @Get('search')
  search(
    @Query() query: InternalServiceAccountSearchQueryDto,
    @Req() request: ServiceCredentialRequest,
  ) {
    const credential = request.serviceCredential;
    if (!credential) {
      throw new UnauthorizedException('Service credential context is required');
    }
    if (!this.credentials.hasScope(credential, 'account.search')) {
      throw new ForbiddenException('Service credential is missing account.search');
    }
    if (credential.serviceKey !== query.serviceKey) {
      throw new ForbiddenException('Service credential does not match serviceKey');
    }
    return this.accounts.searchForService(query.serviceKey, query.q ?? '');
  }
}
