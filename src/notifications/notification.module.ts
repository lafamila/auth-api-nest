import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from '../config/app-config.module';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { AccountEntity } from '../database/entities/account.entity';
import { NotificationActionTargetEntity } from '../database/entities/notification-action-target.entity';
import { NotificationDeliveryAttemptEntity } from '../database/entities/notification-delivery-attempt.entity';
import { NotificationDeliveryEntity } from '../database/entities/notification-delivery.entity';
import { NotificationDeviceEntity } from '../database/entities/notification-device.entity';
import { NotificationIdempotencyEntity } from '../database/entities/notification-idempotency.entity';
import { NotificationSubscriptionEntity } from '../database/entities/notification-subscription.entity';
import { NotificationEntity } from '../database/entities/notification.entity';
import { AuditLogsModule } from '../domain/audit-logs/audit-logs.module';
import { ServiceCredentialsModule } from '../domain/service-credentials/service-credentials.module';
import { InternalServiceCredentialsGuard } from '../internal/internal-service-credentials.guard';
import { OidcModule } from '../oidc/oidc.module';
import { FirebaseCloudMessagingClient } from './firebase-cloud-messaging.client';
import { InternalNotificationsController } from './internal-notifications.controller';
import { NotificationActionTargetsService } from './notification-action-targets.service';
import { NotificationAdminService } from './notification-admin.service';
import { NotificationAppController } from './notification-app.controller';
import { NotificationAppGuard } from './notification-app.guard';
import { NotificationDeliveryWorkerService } from './notification-delivery-worker.service';
import { NotificationDevicesService } from './notification-devices.service';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationRetentionService } from './notification-retention.service';
import { NotificationSendService } from './notification-send.service';
import { NotificationTokenCryptoService } from './notification-token-crypto.service';

const NOTIFICATION_ENTITIES = [
  AccountEntity,
  AccountServicePermissionEntity,
  NotificationDeviceEntity,
  NotificationSubscriptionEntity,
  NotificationActionTargetEntity,
  NotificationEntity,
  NotificationDeliveryEntity,
  NotificationDeliveryAttemptEntity,
  NotificationIdempotencyEntity,
];

@Module({
  imports: [
    AppConfigModule,
    TypeOrmModule.forFeature(NOTIFICATION_ENTITIES),
    AuditLogsModule,
    ServiceCredentialsModule,
    OidcModule,
  ],
  controllers: [NotificationAppController, InternalNotificationsController],
  providers: [
    InternalServiceCredentialsGuard,
    NotificationAppGuard,
    NotificationTokenCryptoService,
    NotificationDevicesService,
    NotificationInboxService,
    NotificationActionTargetsService,
    NotificationSendService,
    NotificationAdminService,
    FirebaseCloudMessagingClient,
    NotificationDeliveryWorkerService,
    NotificationRetentionService,
  ],
  exports: [NotificationActionTargetsService, NotificationAdminService],
})
export class NotificationModule {}
