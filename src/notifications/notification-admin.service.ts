import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationDeliveryEntity } from '../database/entities/notification-delivery.entity';
import { NotificationDeviceEntity } from '../database/entities/notification-device.entity';
import { NotificationSubscriptionEntity } from '../database/entities/notification-subscription.entity';
import { NotificationEntity } from '../database/entities/notification.entity';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';
import { AdminNotificationPageQueryDto } from './dto/notification.dto';

@Injectable()
export class NotificationAdminService {
  constructor(
    @InjectRepository(NotificationDeviceEntity)
    private readonly devices: Repository<NotificationDeviceEntity>,
    @InjectRepository(NotificationSubscriptionEntity)
    private readonly subscriptions: Repository<NotificationSubscriptionEntity>,
    @InjectRepository(NotificationEntity)
    private readonly notifications: Repository<NotificationEntity>,
    @InjectRepository(NotificationDeliveryEntity)
    private readonly deliveries: Repository<NotificationDeliveryEntity>,
    private readonly auditLogs: AuditLogsService,
  ) {}

  listDevices(query: AdminNotificationPageQueryDto) {
    return this.page(this.devices, query, ['account'], (device) => ({
      id: device.id,
      accountId: device.accountId,
      accountLoginId: device.account?.loginId,
      displayName: device.displayName,
      platform: device.platform,
      status: device.status,
      available: Boolean(device.encryptedPushToken),
      lastSeenAt: device.lastSeenAt,
      disabledAt: device.disabledAt,
      createdAt: device.createdAt,
    }));
  }

  listSubscriptions(query: AdminNotificationPageQueryDto) {
    return this.page(
      this.subscriptions,
      query,
      ['account', 'device', 'service'],
      (subscription) => ({
        id: subscription.id,
        accountId: subscription.accountId,
        accountLoginId: subscription.account?.loginId,
        deviceId: subscription.deviceId,
        deviceName: subscription.device?.displayName,
        serviceKey: subscription.service?.serviceKey,
        enabled: subscription.enabled,
        consentedAt: subscription.consentedAt,
        revokedAt: subscription.revokedAt,
      }),
    );
  }

  listNotifications(query: AdminNotificationPageQueryDto) {
    return this.page(
      this.notifications,
      query,
      ['account', 'service'],
      (notification) => ({
        id: notification.id,
        accountId: notification.accountId,
        accountLoginId: notification.account?.loginId,
        serviceKey: notification.service?.serviceKey,
        status: notification.status,
        hasAction: Boolean(notification.actionJson),
        deletedAt: notification.deletedAt,
        createdAt: notification.createdAt,
      }),
    );
  }

  listDeliveries(query: AdminNotificationPageQueryDto) {
    return this.page(
      this.deliveries,
      query,
      ['notification', 'device'],
      (delivery) => ({
        id: delivery.id,
        notificationId: delivery.notificationId,
        deviceId: delivery.deviceId,
        deviceName: delivery.device?.displayName,
        status: delivery.status,
        attempts: delivery.attempts,
        terminalReason: delivery.terminalReason,
        deliveredAt: delivery.deliveredAt,
        nextAttemptAt: delivery.nextAttemptAt,
        createdAt: delivery.createdAt,
      }),
    );
  }

  async disableDevice(deviceId: string, actorAccountId: string) {
    const device = await this.devices.findOneBy({ id: deviceId });
    if (!device) {
      throw new NotFoundException('Notification device not found');
    }
    device.status = 'disabled';
    device.encryptedPushToken = null;
    device.tokenFingerprint = null;
    device.disabledAt = device.disabledAt ?? new Date();
    await this.devices.save(device);
    await this.subscriptions.update(
      { deviceId },
      { enabled: false, revokedAt: new Date() },
    );
    await this.auditLogs.record({
      actorAccountId,
      action: 'notification.device.admin_disable',
      targetType: 'notification_device',
      targetId: device.id,
      afterJson: { status: device.status, disabledAt: device.disabledAt },
    });
    return { id: device.id, status: device.status };
  }

  async revokeSubscription(subscriptionId: string, actorAccountId: string) {
    const subscription = await this.subscriptions.findOneBy({
      id: subscriptionId,
    });
    if (!subscription) {
      throw new NotFoundException('Notification subscription not found');
    }
    subscription.enabled = false;
    subscription.revokedAt = new Date();
    await this.subscriptions.save(subscription);
    await this.auditLogs.record({
      actorAccountId,
      action: 'notification.subscription.admin_revoke',
      targetType: 'notification_subscription',
      targetId: subscription.id,
      afterJson: { enabled: false, revokedAt: subscription.revokedAt },
    });
    return { id: subscription.id, enabled: false };
  }

  private async page<T extends object, R>(
    repository: Repository<T>,
    query: AdminNotificationPageQueryDto,
    relations: string[],
    map: (row: T) => R,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 30;
    const [rows, total] = await repository.findAndCount({
      relations,
      order: { createdAt: 'DESC' } as never,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items: rows.map(map), page, pageSize, total };
  }
}
