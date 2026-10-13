import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { AccountEntity } from '../database/entities/account.entity';
import { NotificationDeliveryEntity } from '../database/entities/notification-delivery.entity';
import { NotificationDeviceEntity } from '../database/entities/notification-device.entity';
import { NotificationIdempotencyEntity } from '../database/entities/notification-idempotency.entity';
import { NotificationSubscriptionEntity } from '../database/entities/notification-subscription.entity';
import { NotificationEntity } from '../database/entities/notification.entity';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';
import { AuthenticatedServiceCredential } from '../domain/service-credentials/service-credential-request';
import { SendNotificationDto } from './dto/notification.dto';
import { NotificationActionTargetsService } from './notification-action-targets.service';

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SendNotificationResult {
  status: 'accepted' | 'no_destinations';
  notificationId: string | null;
  accepted: number;
  deliveryStatus: 'pending' | 'not_created';
  replayed: boolean;
}

@Injectable()
export class NotificationSendService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly actions: NotificationActionTargetsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async listDevices(
    credential: AuthenticatedServiceCredential,
    accountId: string,
  ) {
    await this.assertRecipientAssignment(credential.serviceId, accountId);
    const devices = await this.eligibleDevices(
      this.dataSource.manager,
      credential.serviceId,
      accountId,
    );
    return {
      devices: devices.map((device) => ({
        id: device.id,
        displayName: device.displayName,
        platform: device.platform,
        active: device.status === 'active',
        available: Boolean(device.encryptedPushToken),
      })),
    };
  }

  async send(
    credential: AuthenticatedServiceCredential,
    idempotencyKey: string,
    input: SendNotificationDto,
  ): Promise<SendNotificationResult> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)) {
      throw new BadRequestException('invalid_idempotency_key');
    }
    this.validateDestination(input);
    const metadata = this.validateMetadata(input.metadata);
    const payloadHash = canonicalHash(input);
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [credential.serviceId, idempotencyKey],
      );
      const idempotencyRepository = manager.getRepository(
        NotificationIdempotencyEntity,
      );
      const existing = await idempotencyRepository.findOneBy({
        serviceId: credential.serviceId,
        idempotencyKey,
      });
      if (existing && existing.expiresAt.getTime() > Date.now()) {
        if (existing.payloadHash !== payloadHash) {
          throw new ConflictException('idempotency_payload_conflict');
        }
        return {
          ...(existing.responseJson as Omit<
            SendNotificationResult,
            'replayed'
          >),
          replayed: true,
        };
      }
      if (existing) {
        await idempotencyRepository.remove(existing);
      }
      await this.assertRecipientAssignment(
        credential.serviceId,
        input.accountId,
        manager,
      );
      const eligible = await this.eligibleDevices(
        manager,
        credential.serviceId,
        input.accountId,
      );
      const selected = this.selectDestination(eligible, input);
      const action = await this.actions.resolve(
        credential.serviceId,
        input.action,
      );
      let response: Omit<SendNotificationResult, 'replayed'>;
      if (selected.length === 0) {
        response = {
          status: 'no_destinations',
          notificationId: null,
          accepted: 0,
          deliveryStatus: 'not_created',
        };
      } else {
        const notification = await manager
          .getRepository(NotificationEntity)
          .save(
            manager.getRepository(NotificationEntity).create({
              serviceId: credential.serviceId,
              serviceCredentialId: credential.credentialId,
              accountId: input.accountId,
              title: input.title,
              body: input.body,
              metadataJson: metadata,
              actionJson: action,
              status: 'accepted',
              deletedAt: null,
            }),
          );
        await manager.getRepository(NotificationDeliveryEntity).save(
          selected.map((device) =>
            manager.getRepository(NotificationDeliveryEntity).create({
              notificationId: notification.id,
              deviceId: device.id,
              status: 'pending',
              attempts: 0,
              nextAttemptAt: new Date(),
              claimToken: null,
            }),
          ),
        );
        response = {
          status: 'accepted',
          notificationId: notification.id,
          accepted: selected.length,
          deliveryStatus: 'pending',
        };
        await this.auditLogs.record(
          {
            action: 'notification.send.accepted',
            targetType: 'notification',
            targetId: notification.id,
            afterJson: {
              serviceId: credential.serviceId,
              credentialId: credential.credentialId,
              accountId: input.accountId,
              accepted: selected.length,
              hasAction: Boolean(action),
              metadataKeys: metadata ? Object.keys(metadata) : [],
            },
          },
          manager,
        );
      }
      await idempotencyRepository.save(
        idempotencyRepository.create({
          serviceId: credential.serviceId,
          idempotencyKey,
          payloadHash,
          responseJson: response,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        }),
      );
      return { ...response, replayed: false };
    });
  }

  private async assertRecipientAssignment(
    serviceId: string,
    accountId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    const account = await manager.getRepository(AccountEntity).findOneBy({
      id: accountId,
      status: 'active',
    });
    const assignment = account
      ? await manager
          .getRepository(AccountServicePermissionEntity)
          .createQueryBuilder('permission')
          .innerJoin('permission.service', 'service')
          .where('permission.account_id = :accountId', { accountId })
          .andWhere('permission.service_id = :serviceId', { serviceId })
          .andWhere('permission.status = :status', { status: 'active' })
          .andWhere('service.status = :serviceStatus', {
            serviceStatus: 'active',
          })
          .getOne()
      : null;
    if (!account || !assignment) {
      throw new ForbiddenException('notification_recipient_not_allowed');
    }
  }

  private async eligibleDevices(
    manager: EntityManager,
    serviceId: string,
    accountId: string,
  ): Promise<NotificationDeviceEntity[]> {
    const subscriptions = await manager
      .getRepository(NotificationSubscriptionEntity)
      .createQueryBuilder('subscription')
      .innerJoinAndSelect('subscription.device', 'device')
      .where('subscription.service_id = :serviceId', { serviceId })
      .andWhere('subscription.account_id = :accountId', { accountId })
      .andWhere('subscription.enabled = true')
      .andWhere('device.account_id = :accountId', { accountId })
      .andWhere('device.status = :status', { status: 'active' })
      .andWhere('device.deleted_at IS NULL')
      .andWhere('device.encrypted_push_token IS NOT NULL')
      .getMany();
    return subscriptions.map((subscription) => subscription.device);
  }

  private selectDestination(
    eligible: NotificationDeviceEntity[],
    input: SendNotificationDto,
  ): NotificationDeviceEntity[] {
    if (input.destination?.deviceIds) {
      const requested = [...new Set(input.destination.deviceIds)];
      const byId = new Map(eligible.map((device) => [device.id, device]));
      if (requested.some((id) => !byId.has(id))) {
        throw new ForbiddenException('notification_destination_not_allowed');
      }
      return requested.map((id) => byId.get(id)!);
    }
    if (input.destination?.platform) {
      return eligible.filter(
        (device) => device.platform === input.destination!.platform,
      );
    }
    return eligible;
  }

  private validateDestination(input: SendNotificationDto): void {
    if (
      input.destination?.deviceIds !== undefined &&
      input.destination.platform !== undefined
    ) {
      throw new BadRequestException('notification_destination_is_ambiguous');
    }
  }

  private validateMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Record<string, string | number | boolean | null> | null {
    if (!metadata) {
      return null;
    }
    const entries = Object.entries(metadata);
    if (entries.length > 20 || JSON.stringify(metadata).length > 4096) {
      throw new BadRequestException('notification_metadata_too_large');
    }
    const safe: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) {
        throw new BadRequestException('notification_metadata_invalid');
      }
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new BadRequestException('notification_metadata_invalid');
      }
      safe[key] = value;
    }
    return safe;
  }
}

function canonicalHash(input: SendNotificationDto): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
