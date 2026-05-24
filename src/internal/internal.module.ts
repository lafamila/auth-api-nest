import { Module } from '@nestjs/common';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { ServiceCredentialsModule } from '../domain/service-credentials/service-credentials.module';
import { InternalServiceAccountsController } from './internal-service-accounts.controller';
import { InternalServiceCredentialsGuard } from './internal-service-credentials.guard';

@Module({
  imports: [AccountsModule, ServiceCredentialsModule],
  controllers: [InternalServiceAccountsController],
  providers: [InternalServiceCredentialsGuard],
})
export class InternalModule {}
