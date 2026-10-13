import { ConflictException, ForbiddenException } from '@nestjs/common';
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
import { NotificationSendService } from './notification-send.service';

describe('NotificationSendService', () => {
  const accountId = '01900000-0000-4000-8000-000000000001';
  const credential: AuthenticatedServiceCredential = {
    credentialId: '01900000-0000-4000-8000-000000000002',
    keyId: 'asc_location_todo_test',
    serviceId: '01900000-0000-4000-8000-000000000003',
    serviceKey: 'location-todo',
    scopes: ['notifications.send'],
  };

  it('replays the stored result for the same key and rejects a changed payload', async () => {
    const harness = createHarness([device('ios', '000000000010')]);
    const input = payload();

    await expect(
      harness.service.send(credential, 'location-todo:event:1', input),
    ).resolves.toMatchObject({
      status: 'accepted',
      accepted: 1,
      replayed: false,
    });
    harness.actionResolve.mockRejectedValue(
      new ForbiddenException('notification_action_not_allowed'),
    );
    await expect(
      harness.service.send(credential, 'location-todo:event:1', input),
    ).resolves.toMatchObject({
      status: 'accepted',
      accepted: 1,
      replayed: true,
    });
    expect(harness.notificationSave).toHaveBeenCalledTimes(1);
    expect(harness.actionResolve).toHaveBeenCalledTimes(1);

    await expect(
      harness.service.send(credential, 'location-todo:event:1', {
        ...input,
        body: 'Changed body',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('filters platform destinations to explicitly consented devices', async () => {
    const ios = device('ios', '000000000011');
    const android = device('android', '000000000012');
    const harness = createHarness([ios, android]);

    await expect(
      harness.service.send(credential, 'location-todo:event:2', {
        ...payload(),
        destination: { platform: 'android' },
      }),
    ).resolves.toMatchObject({ accepted: 1, replayed: false });
    expect(harness.deliverySave).toHaveBeenCalledWith([
      expect.objectContaining({ deviceId: android.id }),
    ]);
    expect(harness.subscriptionBuilder.andWhere).toHaveBeenCalledWith(
      'subscription.enabled = true',
    );
  });

  it('returns no_destinations for opt-out and rejects an explicit ineligible device', async () => {
    const noConsent = createHarness([]);
    await expect(
      noConsent.service.send(
        credential,
        'location-todo:event:no-destination',
        payload(),
      ),
    ).resolves.toEqual({
      status: 'no_destinations',
      notificationId: null,
      accepted: 0,
      deliveryStatus: 'not_created',
      replayed: false,
    });
    expect(noConsent.notificationSave).not.toHaveBeenCalled();

    const eligible = createHarness([device('ios', '000000000013')]);
    await expect(
      eligible.service.send(credential, 'location-todo:event:forbidden', {
        ...payload(),
        destination: {
          deviceIds: ['01900000-0000-4000-8000-000000000099'],
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  function createHarness(eligibleDevices: NotificationDeviceEntity[]) {
    let idempotency: NotificationIdempotencyEntity | null = null;
    const notificationSave = jest.fn(async (value: NotificationEntity) => ({
      ...value,
      id: '01900000-0000-4000-8000-000000000020',
    }));
    const deliverySave = jest.fn(
      async (value: NotificationDeliveryEntity[]) => value,
    );
    const subscriptionBuilder = queryBuilder(
      eligibleDevices.map((item) => ({ device: item })),
    );
    const assignmentBuilder = queryBuilder({ id: 'assignment' });
    const repositories = new Map<unknown, unknown>([
      [
        NotificationIdempotencyEntity,
        {
          findOneBy: jest.fn(async () => idempotency),
          remove: jest.fn(async () => {
            idempotency = null;
          }),
          create: jest.fn((value: unknown) => value),
          save: jest.fn(async (value: NotificationIdempotencyEntity) => {
            idempotency = value;
            return value;
          }),
        },
      ],
      [AccountEntity, { findOneBy: jest.fn(async () => ({ id: accountId })) }],
      [
        AccountServicePermissionEntity,
        { createQueryBuilder: jest.fn(() => assignmentBuilder) },
      ],
      [
        NotificationSubscriptionEntity,
        { createQueryBuilder: jest.fn(() => subscriptionBuilder) },
      ],
      [
        NotificationEntity,
        {
          create: jest.fn((value: unknown) => value),
          save: notificationSave,
        },
      ],
      [
        NotificationDeliveryEntity,
        { create: jest.fn((value: unknown) => value), save: deliverySave },
      ],
    ]);
    const manager = {
      query: jest.fn(async () => []),
      getRepository: jest.fn((entity: unknown) => repositories.get(entity)),
    } as unknown as EntityManager;
    const dataSource = {
      manager,
      transaction: jest.fn(async (work: (value: EntityManager) => unknown) =>
        work(manager),
      ),
    } as unknown as DataSource;
    const actionResolve = jest.fn(async () => null);
    const actions = {
      resolve: actionResolve,
    } as unknown as NotificationActionTargetsService;
    const audit = {
      record: jest.fn(async () => undefined),
    } as unknown as AuditLogsService;
    return {
      service: new NotificationSendService(dataSource, actions, audit),
      notificationSave,
      deliverySave,
      subscriptionBuilder,
      actionResolve,
    };
  }

  function queryBuilder(result: unknown) {
    const builder = {
      innerJoin: jest.fn(),
      innerJoinAndSelect: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      getOne: jest.fn(async () => result),
      getMany: jest.fn(async () => result),
    };
    for (const method of [
      builder.innerJoin,
      builder.innerJoinAndSelect,
      builder.where,
      builder.andWhere,
    ]) {
      method.mockReturnValue(builder);
    }
    return builder;
  }

  function payload(): SendNotificationDto {
    return {
      accountId,
      title: 'Location Todo reminder',
      body: 'Buy milk',
      action: {
        targetKey: 'location-todo',
        path: '/notifications/01900000-0000-4000-8000-000000000005',
      },
      metadata: { eventId: '01900000-0000-4000-8000-000000000005' },
    };
  }

  function device(
    platform: 'ios' | 'android',
    suffix: string,
  ): NotificationDeviceEntity {
    return {
      id: `01900000-0000-4000-8000-${suffix}`,
      accountId,
      displayName: `${platform} device`,
      platform,
      status: 'active',
      encryptedPushToken: 'ciphertext',
      deletedAt: null,
    } as NotificationDeviceEntity;
  }
});
