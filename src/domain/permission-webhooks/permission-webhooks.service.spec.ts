import { EntityManager, Repository } from 'typeorm';
import { AesGcmService } from '../../common/crypto/aes-gcm.service';
import { AppConfigService } from '../../config/app-config.service';
import { PermissionWebhookOutboxEntity } from '../../database/entities/permission-webhook-outbox.entity';
import { PermissionWebhookSubscriptionEntity } from '../../database/entities/permission-webhook-subscription.entity';
import { PermissionUpdatedWebhookEvent } from './permission-webhook.contract';
import { PermissionWebhooksService } from './permission-webhooks.service';

describe('PermissionWebhooksService', () => {
  it('enqueues only against the matching service subscription', async () => {
    const saved: PermissionWebhookOutboxEntity[][] = [];
    const create = jest.fn(
      (_entity: unknown, input: PermissionWebhookOutboxEntity) => input,
    );
    const save = jest.fn((rows: PermissionWebhookOutboxEntity[]) => {
      saved.push(rows);
      return Promise.resolve(rows);
    });
    const manager = {
      findOne: jest.fn().mockImplementation((_entity, options) =>
        Promise.resolve(
          options.where.serviceId === 'service-game'
            ? {
                serviceId: 'service-game',
                status: 'active',
                eventTypes: ['permission.updated'],
              }
            : null,
        ),
      ),
      create,
      save,
    } as unknown as EntityManager;
    const service = new PermissionWebhooksService(
      {} as Repository<PermissionWebhookSubscriptionEntity>,
      {} as Repository<PermissionWebhookOutboxEntity>,
      { permissionWebhooksEnabled: true } as AppConfigService,
      {} as AesGcmService,
    );
    const event: PermissionUpdatedWebhookEvent = {
      id: '7f8cf953-cfe8-48cb-8ba4-fdba64780b91',
      type: 'permission.updated',
      occurredAt: '2026-09-22T00:00:00.000Z',
      serviceKey: 'game-platform',
      accountId: 'a46d7a5d-40ea-457a-ad9c-b2c1eca3bd09',
      data: {
        permission: 'user',
        previousPermission: 'visitor',
        status: 'active',
        reason: 'changed',
      },
    };

    await service.enqueue(manager, 'service-other', event);
    await service.enqueue(manager, 'service-game', event);

    expect(saved).toHaveLength(1);
    expect(saved[0][0]).toEqual(
      expect.objectContaining({
        serviceId: 'service-game',
        eventType: 'permission.updated',
      }),
    );
  });
});
