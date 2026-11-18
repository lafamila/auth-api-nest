import { Module } from '@nestjs/common';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { PermissionWebhooksModule } from '../domain/permission-webhooks/permission-webhooks.module';
import { ProviderRevocationsModule } from '../social/provider-revocations.module';
import { AccountLifecycleService } from './account-lifecycle.service';

@Module({
  imports: [
    AccountsModule,
    ProviderRevocationsModule,
    PermissionWebhooksModule,
  ],
  providers: [AccountLifecycleService],
  exports: [AccountLifecycleService],
})
export class AccountLifecycleModule {}
