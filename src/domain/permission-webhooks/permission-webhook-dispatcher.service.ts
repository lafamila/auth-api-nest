import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';
import { PermissionWebhookOutboxEntity } from '../../database/entities/permission-webhook-outbox.entity';
import { PermissionWebhookSubscriptionEntity } from '../../database/entities/permission-webhook-subscription.entity';
import { extractReturnedRow } from '../../database/pg-returning';
import {
  PermissionWebhookEvent,
  permissionWebhookRetryDelayMs,
} from './permission-webhook.contract';
import { PermissionWebhookHttpClient } from './permission-webhook-http.client';
import { PermissionWebhooksService } from './permission-webhooks.service';

interface ClaimedOutboxRow {
  id: string;
  service_id: string;
  event_json: PermissionWebhookEvent;
  attempts: number;
  claim_token: string;
}

@Injectable()
export class PermissionWebhookDispatcherService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PermissionWebhookDispatcherService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PermissionWebhookSubscriptionEntity)
    private readonly subscriptions: Repository<PermissionWebhookSubscriptionEntity>,
    @InjectRepository(PermissionWebhookOutboxEntity)
    private readonly outbox: Repository<PermissionWebhookOutboxEntity>,
    private readonly config: AppConfigService,
    private readonly http: PermissionWebhookHttpClient,
    private readonly webhooks: PermissionWebhooksService,
  ) {}

  onModuleInit(): void {
    if (!this.config.permissionWebhooksEnabled) {
      return;
    }
    this.timer = setInterval(
      () => void this.tick(),
      this.config.permissionWebhookPollIntervalMs,
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
    const subscription = await this.subscriptions.findOne({
      where: { serviceId: claimed.service_id, status: 'active' },
      relations: { service: true },
    });
    if (!subscription) {
      await this.reschedule(claimed, 'Webhook subscription is not active');
      return true;
    }
    try {
      const result = await this.http.post(
        subscription.endpointUrl,
        claimed.event_json,
        this.webhooks.secretFor(subscription),
      );
      if (result.statusCode >= 200 && result.statusCode < 300) {
        await this.outbox.update(
          {
            id: claimed.id,
            attempts: claimed.attempts,
            claimToken: claimed.claim_token,
          },
          {
            status: 'delivered',
            deliveredAt: new Date(),
            nextAttemptAt: null,
            claimToken: null,
            lastResponseStatus: result.statusCode,
            lastResponseBody: result.responseBody,
            lastError: null,
          },
        );
      } else {
        await this.reschedule(
          claimed,
          `Webhook returned HTTP ${result.statusCode}`,
          result.statusCode,
          result.responseBody,
        );
      }
    } catch (error) {
      await this.reschedule(claimed, safeErrorMessage(error));
    }
    return true;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (await this.dispatchOnce()) {
        // Drain currently due events before waiting for the next poll.
      }
    } catch (error) {
      this.logger.error(
        `Permission webhook dispatch failed: ${safeErrorMessage(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async claimNext(): Promise<ClaimedOutboxRow | null> {
    const leaseMs = this.config.permissionWebhookRequestTimeoutMs + 5000;
    await this.dataSource.query(
      `
        UPDATE permission_webhook_outbox
        SET status = 'exhausted',
            next_attempt_at = NULL,
            claim_token = NULL,
            last_error = COALESCE(last_error, 'Delivery lease expired after final attempt'),
            updated_at = now()
        WHERE status = 'pending'
          AND attempts >= $1
          AND next_attempt_at <= now()
      `,
      [this.config.permissionWebhookMaxAttempts],
    );
    const claimToken = randomUUID();
    const claimResult: unknown = await this.dataSource.query(
      `
        UPDATE permission_webhook_outbox
        SET attempts = attempts + 1,
            next_attempt_at = now() + ($2 * interval '1 millisecond'),
            claim_token = $3,
            updated_at = now()
        WHERE id = (
          SELECT outbox.id
          FROM permission_webhook_outbox outbox
          INNER JOIN permission_webhook_subscriptions subscription
            ON subscription.service_id = outbox.service_id
          WHERE outbox.status = 'pending'
            AND outbox.next_attempt_at <= now()
            AND outbox.attempts < $1
            AND subscription.status = 'active'
            AND outbox.event_type = ANY(subscription.event_types)
          ORDER BY outbox.next_attempt_at ASC, outbox.created_at ASC
          FOR UPDATE OF outbox SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, service_id, event_json, attempts, claim_token
      `,
      [this.config.permissionWebhookMaxAttempts, leaseMs, claimToken],
    );
    return extractReturnedRow<ClaimedOutboxRow>(claimResult) ?? null;
  }

  private async reschedule(
    claimed: ClaimedOutboxRow,
    error: string,
    responseStatus: number | null = null,
    responseBody: string | null = null,
  ): Promise<void> {
    const exhausted =
      claimed.attempts >= this.config.permissionWebhookMaxAttempts;
    await this.outbox.update(
      {
        id: claimed.id,
        attempts: claimed.attempts,
        claimToken: claimed.claim_token,
      },
      {
        status: exhausted ? 'exhausted' : 'pending',
        nextAttemptAt: exhausted
          ? null
          : new Date(
              Date.now() + permissionWebhookRetryDelayMs(claimed.attempts),
            ),
        claimToken: null,
        lastResponseStatus: responseStatus,
        lastResponseBody: responseBody,
        lastError: error.slice(0, 1000),
      },
    );
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown webhook error';
}
