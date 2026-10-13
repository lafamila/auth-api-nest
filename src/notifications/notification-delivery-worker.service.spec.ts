import { DataSource, EntityManager, Repository } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';
import { NotificationDeliveryAttemptEntity } from '../database/entities/notification-delivery-attempt.entity';
import { NotificationDeliveryEntity } from '../database/entities/notification-delivery.entity';
import { NotificationEntity } from '../database/entities/notification.entity';
import {
  FirebaseCloudMessagingClient,
  FirebaseSendResult,
} from './firebase-cloud-messaging.client';
import { NotificationDeliveryWorkerService } from './notification-delivery-worker.service';
import { NotificationDevicesService } from './notification-devices.service';
import { NotificationTokenCryptoService } from './notification-token-crypto.service';

describe('NotificationDeliveryWorkerService', () => {
  it('marks an unavailable claimed device terminal without calling Firebase', async () => {
    const harness = createHarness({
      encrypted_push_token: null,
      device_status: 'disabled',
    });

    await expect(harness.worker.dispatchOnce()).resolves.toBe(true);

    expect(harness.firebaseSend).not.toHaveBeenCalled();
    expect(harness.deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'delivery-id' }),
      expect.objectContaining({
        status: 'terminal',
        terminalReason: 'device_unavailable',
      }),
    );
    expect(harness.attemptSave).toHaveBeenCalledWith(
      expect.objectContaining({
        providerStatus: 'terminal',
        providerCode: 'device_unavailable',
      }),
    );
  });

  it('schedules the specified first retry for a transient provider result', async () => {
    const harness = createHarness(
      { attempts: 1 },
      {
        status: 'transient',
        messageId: null,
        code: 'UNAVAILABLE',
        error: 'FCM transient HTTP 503',
      },
    );
    const before = Date.now();

    await harness.worker.dispatchOnce();

    const update = harness.deliveryUpdate.mock.calls[0][1] as {
      status: string;
      nextAttemptAt: Date;
    };
    expect(update.status).toBe('retry');
    expect(update.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + 59_000,
    );
    expect(update.nextAttemptAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 61_000,
    );
  });

  it('exhausts transient retries after the five configured backoffs', async () => {
    const harness = createHarness(
      { attempts: 6 },
      {
        status: 'transient',
        messageId: null,
        code: 'UNAVAILABLE',
        error: 'FCM transient HTTP 503',
      },
    );

    await harness.worker.dispatchOnce();

    expect(harness.deliveryUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'terminal',
        nextAttemptAt: null,
        terminalReason: 'retry_exhausted',
      }),
    );
  });

  it('disables the device after an invalid-token terminal result', async () => {
    const harness = createHarness(
      {},
      {
        status: 'invalid_token',
        messageId: null,
        code: 'UNREGISTERED',
        error: 'FCM rejected the registered device token',
      },
    );

    await harness.worker.dispatchOnce();

    expect(harness.disableInvalidToken).toHaveBeenCalledWith(
      'device-id',
      'claimed-fingerprint',
      expect.anything(),
    );
    expect(harness.deliveryUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'terminal',
        terminalReason: 'UNREGISTERED',
      }),
    );
  });

  it('ignores a stale provider result when the claim token is no longer owned', async () => {
    const harness = createHarness({}, undefined, false);

    await expect(harness.worker.dispatchOnce()).resolves.toBe(true);

    expect(harness.attemptSave).not.toHaveBeenCalled();
    expect(harness.deliveryUpdate).not.toHaveBeenCalled();
    expect(harness.notificationUpdate).not.toHaveBeenCalled();
    expect(harness.disableInvalidToken).not.toHaveBeenCalled();
    expect(harness.aggregateQuery).not.toHaveBeenCalled();
  });

  function createHarness(
    claimedOverrides: Record<string, unknown>,
    providerResult: FirebaseSendResult = {
      status: 'delivered',
      messageId: 'projects/test/messages/1',
      code: null,
      error: null,
    },
    ownsClaim = true,
  ) {
    const claimed = {
      id: 'delivery-id',
      notification_id: 'notification-id',
      device_id: 'device-id',
      attempts: 1,
      claim_token: '01900000-0000-4000-8000-000000000001',
      encrypted_push_token: 'ciphertext',
      token_fingerprint: 'claimed-fingerprint',
      device_status: 'active',
      device_deleted_at: null,
      title: 'Title',
      body: 'Body',
      ...claimedOverrides,
    };
    const deliveryUpdate = jest.fn(async (...args: [unknown, unknown]) => {
      void args;
      return { affected: 1 };
    });
    const attemptSave = jest.fn(async (value: unknown) => value);
    const notificationUpdate = jest.fn(async () => ({ affected: 1 }));
    const deliveryFindOne = jest.fn(async () =>
      ownsClaim ? { id: 'delivery-id' } : null,
    );
    const repositories = new Map<unknown, unknown>([
      [
        NotificationDeliveryEntity,
        { findOne: deliveryFindOne, update: deliveryUpdate },
      ],
      [
        NotificationDeliveryAttemptEntity,
        { create: jest.fn((value: unknown) => value), save: attemptSave },
      ],
      [NotificationEntity, { update: notificationUpdate }],
    ]);
    const aggregateQuery = jest.fn(async () => [
      { delivered: 0, terminal: 1, total: 1 },
    ]);
    const manager = {
      getRepository: jest.fn((entity: unknown) => repositories.get(entity)),
      query: aggregateQuery,
    } as unknown as EntityManager;
    const dataSource = {
      query: jest.fn(async () => [claimed]),
      transaction: jest.fn(async (work: (value: EntityManager) => unknown) =>
        work(manager),
      ),
    } as unknown as DataSource;
    const firebaseSend = jest.fn(async () => providerResult);
    const firebase = {
      send: firebaseSend,
    } as unknown as FirebaseCloudMessagingClient;
    const crypto = {
      decrypt: jest.fn(() => 'raw-fcm-token'),
    } as unknown as NotificationTokenCryptoService;
    const disableInvalidToken = jest.fn(async () => undefined);
    const devices = {
      disableInvalidToken,
    } as unknown as NotificationDevicesService;
    const worker = new NotificationDeliveryWorkerService(
      dataSource,
      {} as Repository<NotificationDeliveryEntity>,
      {} as Repository<NotificationDeliveryAttemptEntity>,
      { notificationsEnabled: false } as AppConfigService,
      firebase,
      crypto,
      devices,
    );
    return {
      worker,
      deliveryUpdate,
      attemptSave,
      notificationUpdate,
      aggregateQuery,
      firebaseSend,
      disableInvalidToken,
    };
  }
});
