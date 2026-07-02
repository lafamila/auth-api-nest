import { Module } from '@nestjs/common';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { ServiceApplicationsModule } from '../domain/service-applications/service-applications.module';
import { ServiceCredentialsModule } from '../domain/service-credentials/service-credentials.module';
import { InternalServiceAccountsController } from './internal-service-accounts.controller';
import { InternalServiceApplicationsController } from './internal-service-applications.controller';
import { InternalServiceCredentialsGuard } from './internal-service-credentials.guard';

@Module({
  imports: [AccountsModule, ServiceApplicationsModule, ServiceCredentialsModule],
  controllers: [InternalServiceAccountsController, InternalServiceApplicationsController],
  providers: [InternalServiceCredentialsGuard],
})
export class InternalModule {}
