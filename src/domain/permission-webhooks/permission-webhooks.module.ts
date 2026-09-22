import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AesGcmService } from '../../common/crypto/aes-gcm.service';
import { AppConfigModule } from '../../config/app-config.module';
import { PermissionWebhookOutboxEntity } from '../../database/entities/permission-webhook-outbox.entity';
import { PermissionWebhookSubscriptionEntity } from '../../database/entities/permission-webhook-subscription.entity';
import { PermissionWebhookDispatcherService } from './permission-webhook-dispatcher.service';
import { PermissionWebhookHttpClient } from './permission-webhook-http.client';
import { PermissionWebhooksService } from './permission-webhooks.service';

@Module({
  imports: [
    AppConfigModule,
    TypeOrmModule.forFeature([
      PermissionWebhookSubscriptionEntity,
      PermissionWebhookOutboxEntity,
    ]),
  ],
  providers: [
    AesGcmService,
    PermissionWebhookHttpClient,
    PermissionWebhooksService,
    PermissionWebhookDispatcherService,
  ],
  exports: [PermissionWebhooksService],
})
export class PermissionWebhooksModule {}
