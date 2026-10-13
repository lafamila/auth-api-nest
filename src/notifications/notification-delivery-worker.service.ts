import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';
import { NotificationDeliveryAttemptEntity } from '../database/entities/notification-delivery-attempt.entity';
import { NotificationDeliveryEntity } from '../database/entities/notification-delivery.entity';
import { NotificationEntity } from '../database/entities/notification.entity';
import { extractReturnedRow } from '../database/pg-returning';
import {
  FirebaseCloudMessagingClient,
  FirebaseSendResult,
} from './firebase-cloud-messaging.client';
import { NotificationDevicesService } from './notification-devices.service';
import { NotificationTokenCryptoService } from './notification-token-crypto.service';

const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];

interface ClaimedDelivery {
  id: string;
  notification_id: string;
  device_id: string;
  attempts: number;
  claim_token: string;
  encrypted_push_token: string | null;
  token_fingerprint: string | null;
  device_status: 'active' | 'disabled';
  device_deleted_at: Date | null;
  title: string;
  body: string;
}

@Injectable()
export class NotificationDeliveryWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationDeliveryWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(NotificationDeliveryEntity)
    private readonly deliveries: Repository<NotificationDeliveryEntity>,
    @InjectRepository(NotificationDeliveryAttemptEntity)
    private readonly attempts: Repository<NotificationDeliveryAttemptEntity>,
    private readonly config: AppConfigService,
    private readonly firebase: FirebaseCloudMessagingClient,
    private readonly crypto: NotificationTokenCryptoService,
    private readonly devices: NotificationDevicesService,
  ) {}

  onModuleInit(): void {
    if (!this.config.notificationsEnabled) {
      return;
    }
    this.timer = setInterval(
      () => void this.tick(),
      this.config.notificationPollIntervalMs,
    );
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async dispatchOnce(): Promise<boolean> {
    const claimed = await this.claimNext();
    if (!claimed) {
      return false;
    }
    let result: FirebaseSendResult;
    if (
      claimed.device_status !== 'active' ||
      claimed.device_deleted_at !== null ||
      !claimed.encrypted_push_token
    ) {
      result = {
        status: 'terminal',
        messageId: null,
        code: 'device_unavailable',
        error: 'Notification device is unavailable',
      };
    } else {
      try {
        result = await this.firebase.send({
          token: this.crypto.decrypt(claimed.encrypted_push_token),
          title: claimed.title,
          body: claimed.body,
          notificationId: claimed.notification_id,
        });
      } catch (error) {
        result = {
          status: 'transient',
          messageId: null,
          code: 'provider_exception',
          error: safeError(error),
        };
      }
    }
    await this.recordResult(claimed, result);
    return true;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (await this.dispatchOnce()) {
        // Drain the due queue before waiting for the next poll.
      }
    } catch (error) {
      this.logger.error(
        `Notification delivery tick failed: ${safeError(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async claimNext(): Promise<ClaimedDelivery | undefined> {
    const claimToken = randomUUID();
    const result: unknown = await this.dataSource.query(
      `
        WITH candidate AS (
          SELECT delivery.id
          FROM notification_deliveries delivery
          WHERE (
            (
              delivery.status IN ('pending', 'retry')
              AND delivery.next_attempt_at <= now()
            ) OR (
              delivery.status = 'processing'
              AND delivery.updated_at < now() - interval '10 minutes'
            )
          )
          ORDER BY delivery.next_attempt_at ASC NULLS FIRST, delivery.created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        ), claimed AS (
          UPDATE notification_deliveries delivery
          SET status = 'processing',
              attempts = delivery.attempts + 1,
              claim_token = $1,
              updated_at = now()
          FROM candidate
          WHERE delivery.id = candidate.id
          RETURNING delivery.*
        )
        SELECT claimed.id,
               claimed.notification_id,
               claimed.device_id,
               claimed.attempts,
               claimed.claim_token,
               device.encrypted_push_token,
               device.token_fingerprint,
               device.status AS device_status,
               device.deleted_at AS device_deleted_at,
               notification.title,
               notification.body
        FROM claimed
        JOIN notification_devices device ON device.id = claimed.device_id
        JOIN notifications notification ON notification.id = claimed.notification_id
      `,
      [claimToken],
    );
    return extractReturnedRow<ClaimedDelivery>(result);
  }

  private async recordResult(
    claimed: ClaimedDelivery,
    result: FirebaseSendResult,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const ownedDelivery = await manager
        .getRepository(NotificationDeliveryEntity)
        .findOne({
          where: { id: claimed.id, claimToken: claimed.claim_token },
          lock: { mode: 'pessimistic_write' },
        });
      if (!ownedDelivery) {
        return;
      }
      await manager.getRepository(NotificationDeliveryAttemptEntity).save(
        manager.getRepository(NotificationDeliveryAttemptEntity).create({
          deliveryId: claimed.id,
          attemptNumber: claimed.attempts,
          providerStatus: result.status,
          providerCode: result.code,
          sanitizedError: result.error?.slice(0, 240) ?? null,
        }),
      );
      const match = { id: claimed.id, claimToken: claimed.claim_token };
      if (result.status === 'delivered') {
        await manager.getRepository(NotificationDeliveryEntity).update(match, {
          status: 'delivered',
          claimToken: null,
          nextAttemptAt: null,
          deliveredAt: new Date(),
          providerMessageId: result.messageId,
          terminalReason: null,
        });
      } else if (
        result.status === 'transient' &&
        claimed.attempts <= RETRY_DELAYS_MS.length
      ) {
        await manager.getRepository(NotificationDeliveryEntity).update(match, {
          status: 'retry',
          claimToken: null,
          nextAttemptAt: new Date(
            Date.now() + RETRY_DELAYS_MS[claimed.attempts - 1],
          ),
          terminalReason: null,
        });
      } else {
        await manager.getRepository(NotificationDeliveryEntity).update(match, {
          status: 'terminal',
          claimToken: null,
          nextAttemptAt: null,
          terminalReason:
            result.status === 'transient'
              ? 'retry_exhausted'
              : (result.code ?? result.status),
        });
      }
      if (result.status === 'invalid_token' && claimed.token_fingerprint) {
        await this.devices.disableInvalidToken(
          claimed.device_id,
          claimed.token_fingerprint,
          manager,
        );
      }
      await this.refreshNotificationStatus(claimed.notification_id, manager);
    });
  }

  private async refreshNotificationStatus(
    notificationId: string,
    manager: EntityManager,
  ): Promise<void> {
    const rows: Array<{ delivered: number; terminal: number; total: number }> =
      await manager.query(
        `
        SELECT
          count(*) FILTER (WHERE status = 'delivered')::integer AS delivered,
          count(*) FILTER (WHERE status = 'terminal')::integer AS terminal,
          count(*)::integer AS total
        FROM notification_deliveries
        WHERE notification_id = $1
      `,
        [notificationId],
      );
    const counts = rows[0];
    if (!counts || counts.delivered + counts.terminal < counts.total) {
      return;
    }
    const status =
      counts.delivered === counts.total
        ? 'delivered'
        : counts.delivered > 0
          ? 'partial'
          : 'failed';
    await manager
      .getRepository(NotificationEntity)
      .update({ id: notificationId }, { status });
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : 'Unknown error';
}
