import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { NotificationDeviceEntity } from '../database/entities/notification-device.entity';
import { NotificationSubscriptionEntity } from '../database/entities/notification-subscription.entity';
import { ServiceEntity } from '../database/entities/service.entity';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';
import {
  RegisterNotificationDeviceDto,
  UpdateNotificationDeviceDto,
} from './dto/notification.dto';
import { NotificationTokenCryptoService } from './notification-token-crypto.service';

@Injectable()
export class NotificationDevicesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(NotificationDeviceEntity)
    private readonly devices: Repository<NotificationDeviceEntity>,
    @InjectRepository(NotificationSubscriptionEntity)
    private readonly subscriptions: Repository<NotificationSubscriptionEntity>,
    private readonly crypto: NotificationTokenCryptoService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async register(accountId: string, input: RegisterNotificationDeviceDto) {
    const fingerprint = this.crypto.fingerprint(input.pushToken);
    const now = new Date();
    const saved = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [accountId, input.installationId],
      );
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        fingerprint,
      ]);
      const repository = manager.getRepository(NotificationDeviceEntity);
      let device = await repository.findOneBy({
        accountId,
        installationId: input.installationId,
      });
      const priorTokenOwner = await repository.findOneBy({
        tokenFingerprint: fingerprint,
      });
      if (priorTokenOwner && priorTokenOwner.id !== device?.id) {
        await this.disableDevice(priorTokenOwner, manager, now);
        await repository.save(priorTokenOwner);
      }
      if (!device) {
        device = repository.create({
          accountId,
          installationId: input.installationId,
        });
      }
      device.displayName = input.displayName;
      device.platform = input.platform;
      device.appVersion = input.appVersion ?? null;
      device.buildNumber = input.buildNumber ?? null;
      device.encryptedPushToken = this.crypto.encrypt(input.pushToken);
      device.tokenFingerprint = fingerprint;
      device.status = 'active';
      device.disabledAt = null;
      device.deletedAt = null;
      device.lastSeenAt = now;
      const result = await repository.save(device);
      await this.auditLogs.record(
        {
          actorAccountId: accountId,
          action: 'notification.device.register',
          targetType: 'notification_device',
          targetId: result.id,
          afterJson: this.safeDevice(result),
        },
        manager,
      );
      return result;
    });
    return this.safeDevice(saved);
  }

  async list(accountId: string) {
    const [devices, services, subscriptions] = await Promise.all([
      this.devices.find({ where: { accountId }, order: { createdAt: 'DESC' } }),
      this.assignedServices(accountId),
      this.subscriptions.find({
        where: { accountId },
        relations: { service: true },
      }),
    ]);
    const subscriptionByDevice = new Map<string, Map<string, boolean>>();
    for (const subscription of subscriptions) {
      const byService =
        subscriptionByDevice.get(subscription.deviceId) ?? new Map();
      byService.set(subscription.service.serviceKey, subscription.enabled);
      subscriptionByDevice.set(subscription.deviceId, byService);
    }
    return {
      items: devices.map((device) => ({
        ...this.safeDevice(device),
        subscriptions: services.map((service) => ({
          serviceKey: service.serviceKey,
          serviceName: service.name,
          enabled:
            subscriptionByDevice.get(device.id)?.get(service.serviceKey) ??
            false,
        })),
      })),
    };
  }

  async update(
    accountId: string,
    deviceId: string,
    input: UpdateNotificationDeviceDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const device = await this.ownedDevice(accountId, deviceId, manager, true);
      if (input.displayName !== undefined) {
        device.displayName = input.displayName;
      }
      if (input.active === false) {
        await this.disableDevice(device, manager, new Date());
      } else if (input.active === true && device.status !== 'active') {
        throw new ConflictException(
          'A disabled device must register a push token before reactivation',
        );
      }
      const saved = await manager
        .getRepository(NotificationDeviceEntity)
        .save(device);
      await this.auditLogs.record(
        {
          actorAccountId: accountId,
          action: 'notification.device.update',
          targetType: 'notification_device',
          targetId: saved.id,
          afterJson: this.safeDevice(saved),
        },
        manager,
      );
      return this.safeDevice(saved);
    });
  }

  async remove(accountId: string, deviceId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const device = await this.ownedDevice(accountId, deviceId, manager, true);
      const now = new Date();
      await this.disableDevice(device, manager, now);
      device.deletedAt = now;
      await manager.getRepository(NotificationDeviceEntity).save(device);
      await this.auditLogs.record(
        {
          actorAccountId: accountId,
          action: 'notification.device.delete',
          targetType: 'notification_device',
          targetId: device.id,
          afterJson: this.safeDevice(device),
        },
        manager,
      );
    });
  }

  async setSubscription(
    accountId: string,
    deviceId: string,
    serviceKey: string,
    enabled: boolean,
  ) {
    return this.dataSource.transaction((manager) =>
      this.setSubscriptionInTransaction(
        accountId,
        deviceId,
        serviceKey,
        enabled,
        manager,
      ),
    );
  }

  async setSubscriptionForAllDevices(
    accountId: string,
    serviceKey: string,
    enabled: boolean,
  ) {
    const results = await this.dataSource.transaction(async (manager) => {
      const service = await this.assertAssignedService(
        accountId,
        serviceKey,
        manager,
      );
      const devices = await manager
        .getRepository(NotificationDeviceEntity)
        .createQueryBuilder('device')
        .setLock('pessimistic_write')
        .where('device.account_id = :accountId', { accountId })
        .andWhere('device.status = :status', { status: 'active' })
        .andWhere('device.deleted_at IS NULL')
        .andWhere('device.encrypted_push_token IS NOT NULL')
        .getMany();
      const results = [];
      for (const device of devices) {
        results.push(
          await this.saveSubscription(
            accountId,
            device,
            service,
            enabled,
            manager,
          ),
        );
      }
      return results;
    });
    return { serviceKey, enabled, updatedDevices: results.length };
  }

  async disableInvalidToken(
    deviceId: string,
    tokenFingerprint: string,
    transactionManager?: EntityManager,
  ): Promise<boolean> {
    const disable = async (manager: EntityManager): Promise<boolean> => {
      const repository = manager.getRepository(NotificationDeviceEntity);
      const device = await repository.findOne({
        where: {
          id: deviceId,
          tokenFingerprint,
          status: 'active',
          deletedAt: IsNull(),
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!device) {
        return false;
      }
      await this.disableDevice(device, manager, new Date());
      await repository.save(device);
      return true;
    };
    return transactionManager
      ? disable(transactionManager)
      : this.dataSource.transaction(disable);
  }

  private async setSubscriptionInTransaction(
    accountId: string,
    deviceId: string,
    serviceKey: string,
    enabled: boolean,
    manager: EntityManager,
  ) {
    const device = await this.ownedDevice(accountId, deviceId, manager, true);
    const service = await this.assertAssignedService(
      accountId,
      serviceKey,
      manager,
    );
    if (
      device.status !== 'active' ||
      device.deletedAt ||
      !device.encryptedPushToken
    ) {
      throw new ConflictException('Notification device is not active');
    }
    return this.saveSubscription(accountId, device, service, enabled, manager);
  }

  private async saveSubscription(
    accountId: string,
    device: NotificationDeviceEntity,
    service: ServiceEntity,
    enabled: boolean,
    manager: EntityManager,
  ) {
    if (enabled) {
      const eligible = await manager
        .getRepository(NotificationDeviceEntity)
        .createQueryBuilder('device')
        .setLock('pessimistic_write')
        .where('device.id = :deviceId', { deviceId: device.id })
        .andWhere('device.account_id = :accountId', { accountId })
        .andWhere('device.status = :status', { status: 'active' })
        .andWhere('device.deleted_at IS NULL')
        .andWhere('device.encrypted_push_token IS NOT NULL')
        .getOne();
      if (!eligible) {
        throw new ConflictException('Notification device is not active');
      }
    }
    const repository = manager.getRepository(NotificationSubscriptionEntity);
    let subscription = await repository.findOneBy({
      deviceId: device.id,
      serviceId: service.id,
    });
    if (!subscription) {
      subscription = repository.create({
        accountId,
        deviceId: device.id,
        serviceId: service.id,
      });
    }
    subscription.enabled = enabled;
    subscription.consentedAt = enabled ? new Date() : subscription.consentedAt;
    subscription.revokedAt = enabled ? null : new Date();
    const saved = await repository.save(subscription);
    await this.auditLogs.record(
      {
        actorAccountId: accountId,
        action: enabled
          ? 'notification.subscription.opt_in'
          : 'notification.subscription.opt_out',
        targetType: 'notification_subscription',
        targetId: saved.id,
        afterJson: {
          deviceId: device.id,
          serviceKey: service.serviceKey,
          enabled,
        },
      },
      manager,
    );
    return {
      deviceId: device.id,
      serviceKey: service.serviceKey,
      serviceName: service.name,
      enabled: saved.enabled,
      consentedAt: saved.consentedAt,
      revokedAt: saved.revokedAt,
    };
  }

  private async disableDevice(
    device: NotificationDeviceEntity,
    manager: EntityManager,
    now: Date,
  ): Promise<void> {
    device.status = 'disabled';
    device.encryptedPushToken = null;
    device.tokenFingerprint = null;
    device.disabledAt = device.disabledAt ?? now;
    await manager
      .getRepository(NotificationSubscriptionEntity)
      .update({ deviceId: device.id }, { enabled: false, revokedAt: now });
  }

  private async ownedDevice(
    accountId: string,
    deviceId: string,
    manager: EntityManager,
    lock = false,
  ): Promise<NotificationDeviceEntity> {
    const device = await manager
      .getRepository(NotificationDeviceEntity)
      .findOne({
        where: { id: deviceId, accountId },
        ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
      });
    if (!device) {
      throw new NotFoundException('Notification device not found');
    }
    return device;
  }

  private async assertAssignedService(
    accountId: string,
    serviceKey: string,
    manager: EntityManager,
  ): Promise<ServiceEntity> {
    const assignment = await manager
      .getRepository(AccountServicePermissionEntity)
      .createQueryBuilder('permission')
      .innerJoinAndSelect('permission.service', 'service')
      .where('permission.account_id = :accountId', { accountId })
      .andWhere('permission.status = :status', { status: 'active' })
      .andWhere('service.service_key = :serviceKey', { serviceKey })
      .andWhere('service.status = :serviceStatus', { serviceStatus: 'active' })
      .getOne();
    if (!assignment) {
      throw new ForbiddenException('notification_service_not_assigned');
    }
    return assignment.service;
  }

  private async assignedServices(accountId: string): Promise<ServiceEntity[]> {
    const assignments = await this.dataSource
      .getRepository(AccountServicePermissionEntity)
      .createQueryBuilder('permission')
      .innerJoinAndSelect('permission.service', 'service')
      .where('permission.account_id = :accountId', { accountId })
      .andWhere('permission.status = :status', { status: 'active' })
      .andWhere('service.status = :serviceStatus', { serviceStatus: 'active' })
      .orderBy('service.name', 'ASC')
      .getMany();
    return assignments.map((assignment) => assignment.service);
  }

  private safeDevice(device: NotificationDeviceEntity) {
    return {
      id: device.id,
      installationId: device.installationId,
      displayName: device.displayName,
      platform: device.platform,
      appVersion: device.appVersion,
      buildNumber: device.buildNumber,
      status: device.status,
      active: device.status === 'active' && !device.deletedAt,
      available:
        device.status === 'active' &&
        !device.deletedAt &&
        Boolean(device.encryptedPushToken),
      lastSeenAt: device.lastSeenAt,
      disabledAt: device.disabledAt,
      deletedAt: device.deletedAt,
      createdAt: device.createdAt,
      updatedAt: device.updatedAt,
    };
  }
}
