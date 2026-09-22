import { DataSource, Repository } from 'typeorm';
import { AppConfigService } from '../../config/app-config.service';
import { PermissionWebhookOutboxEntity } from '../../database/entities/permission-webhook-outbox.entity';
import { PermissionWebhookSubscriptionEntity } from '../../database/entities/permission-webhook-subscription.entity';
import { PermissionUpdatedWebhookEvent } from './permission-webhook.contract';
import { PermissionWebhookDispatcherService } from './permission-webhook-dispatcher.service';
import { PermissionWebhookHttpClient } from './permission-webhook-http.client';
import { PermissionWebhooksService } from './permission-webhooks.service';

const event: PermissionUpdatedWebhookEvent = {
  id: 'a1d88199-3b7f-4754-a177-810fc85c484e',
  type: 'permission.updated',
  occurredAt: '2026-09-22T00:00:00.000Z',
  serviceKey: 'game-platform',
  accountId: 'bde4a8bc-c610-40d6-9d05-b3b47205dc02',
  data: {
    permission: 'user',
    previousPermission: 'visitor',
    status: 'active',
    reason: 'approved',
  },
};

describe('PermissionWebhookDispatcherService', () => {
  const config = {
    permissionWebhookRequestTimeoutMs: 100,
    permissionWebhookMaxAttempts: 6,
  } as AppConfigService;

  afterEach(() => jest.useRealTimers());

  it('sweeps a crashed final-attempt lease to exhausted before claiming', async () => {
    const queries: string[] = [];
    const dataSource = {
      query: jest.fn().mockImplementation((sql: string) => {
        queries.push(sql);
        return Promise.resolve([]);
      }),
    } as unknown as DataSource;
    const dispatcher = createDispatcher({ dataSource, config });

    await expect(dispatcher.dispatchOnce()).resolves.toBe(false);
    expect(queries[0]).toContain("SET status = 'exhausted'");
    expect(queries[0]).toContain('attempts >= $1');
    expect(queries[1]).toContain('FOR UPDATE OF outbox SKIP LOCKED');
  });

  it('extracts a claimed row from the Postgres driver wrapped RETURNING shape', async () => {
    const post = jest.fn().mockResolvedValue({
      statusCode: 204,
      responseBody: '',
    });
    const claimed = {
      id: event.id,
      service_id: 'service-1',
      event_json: event,
      attempts: 1,
      claim_token: 'wrapped-claim',
    };
    let claimQuerySeen = false;
    const dataSource = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('RETURNING') && !claimQuerySeen) {
          claimQuerySeen = true;
          return Promise.resolve([[claimed], 1]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DataSource;
    const dispatcher = createDispatcher({ dataSource, config, post });

    await expect(dispatcher.dispatchOnce()).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith(
      'https://game.example.com/api/auth/webhooks',
      event,
      'receiver-secret',
    );
  });

  it('uses the claim token and attempt in completion updates so a stale sender cannot win', async () => {
    let resolvePost!: (value: {
      statusCode: number;
      responseBody: string;
    }) => void;
    const post = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve;
      }),
    );
    let state = {
      status: 'pending',
      attempts: 1,
      claimToken: 'old-claim',
    };
    const update = jest.fn().mockImplementation((where, values) => {
      if (
        where.attempts === state.attempts &&
        where.claimToken === state.claimToken
      ) {
        state = { ...state, ...values };
      }
      return Promise.resolve({ affected: 1 });
    });
    const dispatcher = createDispatcher({
      config,
      claimed: {
        id: event.id,
        service_id: 'service-1',
        event_json: event,
        attempts: 1,
        claim_token: 'old-claim',
      },
      post,
      update,
    });

    const dispatch = dispatcher.dispatchOnce();
    await Promise.resolve();
    state = { status: 'pending', attempts: 0, claimToken: 'manual-retry' };
    resolvePost({ statusCode: 204, responseBody: '' });
    await dispatch;

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: event.id,
        attempts: 1,
        claimToken: 'old-claim',
      }),
      expect.objectContaining({ status: 'delivered' }),
    );
    expect(state.status).toBe('pending');
    expect(state.claimToken).toBe('manual-retry');
  });

  it('marks the bounded final failed attempt exhausted', async () => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const dispatcher = createDispatcher({
      config,
      claimed: {
        id: event.id,
        service_id: 'service-1',
        event_json: event,
        attempts: 6,
        claim_token: 'final-claim',
      },
      post: jest.fn().mockResolvedValue({
        statusCode: 503,
        responseBody: 'unavailable',
      }),
      update,
    });

    await expect(dispatcher.dispatchOnce()).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: 'final-claim', attempts: 6 }),
      expect.objectContaining({
        status: 'exhausted',
        nextAttemptAt: null,
        claimToken: null,
      }),
    );
  });

  it('reschedules a non-final failure with bounded exponential backoff', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-22T00:00:00.000Z'));
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const dispatcher = createDispatcher({
      config,
      claimed: {
        id: event.id,
        service_id: 'service-1',
        event_json: event,
        attempts: 2,
        claim_token: 'retry-claim',
      },
      post: jest.fn().mockRejectedValue(new Error('connection refused')),
      update,
    });

    await expect(dispatcher.dispatchOnce()).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: 'retry-claim', attempts: 2 }),
      expect.objectContaining({
        status: 'pending',
        nextAttemptAt: new Date('2026-09-22T00:00:10.000Z'),
        claimToken: null,
      }),
    );
  });
});

function createDispatcher(options: {
  config: AppConfigService;
  dataSource?: DataSource;
  claimed?: Record<string, unknown>;
  post?: jest.Mock;
  update?: jest.Mock;
}) {
  let claimReturned = false;
  const dataSource =
    options.dataSource ??
    ({
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('RETURNING') && !claimReturned) {
          claimReturned = true;
          return Promise.resolve(options.claimed ? [options.claimed] : []);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DataSource);
  const subscriptions = {
    findOne: jest.fn().mockResolvedValue({
      endpointUrl: 'https://game.example.com/api/auth/webhooks',
      service: { serviceKey: 'game-platform' },
    }),
  } as unknown as Repository<PermissionWebhookSubscriptionEntity>;
  const outbox = {
    update: options.update ?? jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as Repository<PermissionWebhookOutboxEntity>;
  const http = {
    post:
      options.post ??
      jest.fn().mockResolvedValue({ statusCode: 204, responseBody: '' }),
  } as unknown as PermissionWebhookHttpClient;
  const webhooks = {
    secretFor: jest.fn().mockReturnValue('receiver-secret'),
  } as unknown as PermissionWebhooksService;
  return new PermissionWebhookDispatcherService(
    dataSource,
    subscriptions,
    outbox,
    options.config,
    http,
    webhooks,
  );
}
