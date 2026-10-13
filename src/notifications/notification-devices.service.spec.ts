import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { NotificationDeviceEntity } from '../database/entities/notification-device.entity';
import { NotificationSubscriptionEntity } from '../database/entities/notification-subscription.entity';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';
import { NotificationDevicesService } from './notification-devices.service';
import { NotificationTokenCryptoService } from './notification-token-crypto.service';

describe('NotificationDevicesService', () => {
  const accountId = '01900000-0000-4000-8000-000000000001';
  const now = new Date('2026-10-13T00:00:00.000Z');

  it('transfers a reused token by disabling and persisting its prior owner', async () => {
    const prior = device({
      id: '01900000-0000-4000-8000-000000000010',
      accountId: '01900000-0000-4000-8000-000000000002',
      installationId: 'prior-installation',
      encryptedPushToken: 'old-ciphertext',
      tokenFingerprint: 'fingerprint',
    });
    const saved: NotificationDeviceEntity[] = [];
    const deviceRepository = {
      findOneBy: jest.fn(async (where: Record<string, unknown>) => {
        if (where.tokenFingerprint === 'fingerprint') return prior;
        return null;
      }),
      create: jest.fn((value: Partial<NotificationDeviceEntity>) =>
        device({
          ...value,
          id: '01900000-0000-4000-8000-000000000011',
        }),
      ),
      save: jest.fn(async (value: NotificationDeviceEntity) => {
        saved.push({ ...value });
        return value;
      }),
    } as unknown as Repository<NotificationDeviceEntity>;
    const subscriptionUpdate = jest.fn(async () => ({ affected: 1 }));
    const subscriptionRepository = {
      update: subscriptionUpdate,
    } as unknown as Repository<NotificationSubscriptionEntity>;
    const manager = managerWith(deviceRepository, subscriptionRepository);
    const service = createService(manager, deviceRepository);

    const result = await service.register(accountId, {
      installationId: 'new-installation',
      displayName: 'New phone',
      platform: 'ios',
      pushToken: 'shared-fcm-token-value',
    });

    expect(saved[0]).toMatchObject({
      id: prior.id,
      status: 'disabled',
      encryptedPushToken: null,
      tokenFingerprint: null,
    });
    expect(subscriptionUpdate).toHaveBeenCalledWith(
      { deviceId: prior.id },
      expect.objectContaining({ enabled: false, revokedAt: expect.any(Date) }),
    );
    expect(saved[1]).toMatchObject({
      accountId,
      installationId: 'new-installation',
      status: 'active',
      encryptedPushToken: 'encrypted:shared-fcm-token-value',
      tokenFingerprint: 'fingerprint',
    });
    expect(result).not.toHaveProperty('encryptedPushToken');
    expect(result).not.toHaveProperty('tokenFingerprint');
  });

  it('clears the token and revokes consent when logout deletes a device', async () => {
    const owned = device({
      id: '01900000-0000-4000-8000-000000000012',
      accountId,
      installationId: 'logout-installation',
      encryptedPushToken: 'ciphertext',
      tokenFingerprint: 'fingerprint',
    });
    const deviceSave = jest.fn(
      async (value: NotificationDeviceEntity) => value,
    );
    const deviceRepository = {
      findOne: jest.fn(async () => owned),
      save: deviceSave,
    } as unknown as Repository<NotificationDeviceEntity>;
    const subscriptionUpdate = jest.fn(async () => ({ affected: 1 }));
    const subscriptionRepository = {
      update: subscriptionUpdate,
    } as unknown as Repository<NotificationSubscriptionEntity>;
    const manager = managerWith(deviceRepository, subscriptionRepository);
    const service = createService(manager, deviceRepository);

    await service.remove(accountId, owned.id);

    expect(deviceSave).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'disabled',
        encryptedPushToken: null,
        tokenFingerprint: null,
        disabledAt: expect.any(Date),
        deletedAt: expect.any(Date),
      }),
    );
    expect(subscriptionUpdate).toHaveBeenCalledWith(
      { deviceId: owned.id },
      expect.objectContaining({ enabled: false, revokedAt: expect.any(Date) }),
    );
  });

  it('does not disable a re-registered device when the claimed fingerprint is stale', async () => {
    const deviceSave = jest.fn();
    const deviceFindOne = jest.fn(async () => null);
    const deviceRepository = {
      findOne: deviceFindOne,
      save: deviceSave,
    } as unknown as Repository<NotificationDeviceEntity>;
    const subscriptionUpdate = jest.fn();
    const subscriptionRepository = {
      update: subscriptionUpdate,
    } as unknown as Repository<NotificationSubscriptionEntity>;
    const manager = managerWith(deviceRepository, subscriptionRepository);
    const service = createService(manager, deviceRepository);

    await expect(
      service.disableInvalidToken(
        '01900000-0000-4000-8000-000000000013',
        'claimed-old-fingerprint',
        manager,
      ),
    ).resolves.toBe(false);

    expect(deviceFindOne).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tokenFingerprint: 'claimed-old-fingerprint',
        status: 'active',
      }),
      lock: { mode: 'pessimistic_write' },
    });
    expect(deviceSave).not.toHaveBeenCalled();
    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });

  it('disables the device when its current fingerprint still matches the claim', async () => {
    const current = device({
      id: '01900000-0000-4000-8000-000000000015',
      tokenFingerprint: 'claimed-fingerprint',
    });
    const deviceSave = jest.fn(
      async (value: NotificationDeviceEntity) => value,
    );
    const deviceRepository = {
      findOne: jest.fn(async () => current),
      save: deviceSave,
    } as unknown as Repository<NotificationDeviceEntity>;
    const subscriptionUpdate = jest.fn(async () => ({ affected: 1 }));
    const subscriptionRepository = {
      update: subscriptionUpdate,
    } as unknown as Repository<NotificationSubscriptionEntity>;
    const manager = managerWith(deviceRepository, subscriptionRepository);
    const service = createService(manager, deviceRepository);

    await expect(
      service.disableInvalidToken(current.id, 'claimed-fingerprint', manager),
    ).resolves.toBe(true);

    expect(deviceSave).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'disabled',
        encryptedPushToken: null,
        tokenFingerprint: null,
      }),
    );
    expect(subscriptionUpdate).toHaveBeenCalledWith(
      { deviceId: current.id },
      expect.objectContaining({ enabled: false }),
    );
  });

  it('locks token-backed devices inside the batch transaction and rechecks before opt-in', async () => {
    const active = device({
      id: '01900000-0000-4000-8000-000000000014',
      accountId,
    });
    const serviceEntity = {
      id: '01900000-0000-4000-8000-000000000020',
      serviceKey: 'location-todo',
      name: 'Location Todo',
      status: 'active',
    };
    const batchBuilder = queryBuilder({ many: [active] });
    const recheckBuilder = queryBuilder({ one: null });
    const deviceRepository = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(batchBuilder)
        .mockReturnValueOnce(recheckBuilder),
    } as unknown as Repository<NotificationDeviceEntity>;
    const subscriptionSave = jest.fn();
    const subscriptionRepository = {
      findOneBy: jest.fn(async () => null),
      create: jest.fn((value: unknown) => value),
      save: subscriptionSave,
    } as unknown as Repository<NotificationSubscriptionEntity>;
    const assignmentBuilder = queryBuilder({
      one: { service: serviceEntity },
    });
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === NotificationDeviceEntity) return deviceRepository;
        if (entity === NotificationSubscriptionEntity)
          return subscriptionRepository;
        return { createQueryBuilder: jest.fn(() => assignmentBuilder) };
      }),
    } as unknown as EntityManager;
    const service = createService(manager, deviceRepository);

    await expect(
      service.setSubscriptionForAllDevices(accountId, 'location-todo', true),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(batchBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(batchBuilder.andWhere).toHaveBeenCalledWith(
      'device.encrypted_push_token IS NOT NULL',
    );
    expect(recheckBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(subscriptionSave).not.toHaveBeenCalled();
  });

  function createService(
    manager: EntityManager,
    devices: Repository<NotificationDeviceEntity>,
  ): NotificationDevicesService {
    const dataSource = {
      transaction: jest.fn(async (work: (value: EntityManager) => unknown) =>
        work(manager),
      ),
    } as unknown as DataSource;
    const crypto = {
      fingerprint: jest.fn(() => 'fingerprint'),
      encrypt: jest.fn((value: string) => `encrypted:${value}`),
    } as unknown as NotificationTokenCryptoService;
    const audit = {
      record: jest.fn(async () => undefined),
    } as unknown as AuditLogsService;
    return new NotificationDevicesService(
      dataSource,
      devices,
      {} as Repository<NotificationSubscriptionEntity>,
      crypto,
      audit,
    );
  }

  function managerWith(
    devices: Repository<NotificationDeviceEntity>,
    subscriptions: Repository<NotificationSubscriptionEntity>,
  ): EntityManager {
    return {
      query: jest.fn(async () => []),
      getRepository: jest.fn((entity: unknown) =>
        entity === NotificationDeviceEntity ? devices : subscriptions,
      ),
    } as unknown as EntityManager;
  }

  function device(
    value: Partial<NotificationDeviceEntity>,
  ): NotificationDeviceEntity {
    return {
      id: '01900000-0000-4000-8000-000000000099',
      accountId,
      installationId: 'installation-id',
      displayName: 'Phone',
      platform: 'ios',
      appVersion: null,
      buildNumber: null,
      encryptedPushToken: 'ciphertext',
      tokenFingerprint: 'fingerprint',
      status: 'active',
      lastSeenAt: now,
      disabledAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      ...value,
    } as NotificationDeviceEntity;
  }

  function queryBuilder(result: { one?: unknown; many?: unknown[] }) {
    const builder = {
      innerJoinAndSelect: jest.fn(),
      setLock: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      getOne: jest.fn(async () => result.one ?? null),
      getMany: jest.fn(async () => result.many ?? []),
    };
    for (const method of [
      builder.innerJoinAndSelect,
      builder.setLock,
      builder.where,
      builder.andWhere,
      builder.orderBy,
    ]) {
      method.mockReturnValue(builder);
    }
    return builder;
  }
});
