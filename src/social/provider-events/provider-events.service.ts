import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AesGcmService } from '../../common/crypto/aes-gcm.service';
import { AppConfigService } from '../../config/app-config.service';
import { EventProvider } from '../../database/entities/provider-event.entity';
import { extractReturnedRow } from '../../database/pg-returning';
import { AccountLifecycleService } from '../../portal/account-lifecycle.service';
import {
  EVENT_TTL_MS,
  QueuedProviderEventTarget,
  VerifiedProviderEvent,
  providerEventIdentitySnapshot,
} from './provider-event.types';

interface ClaimedEvent {
  id: string;
  provider: EventProvider;
  encrypted_target: string;
  attempts: number;
  lease_token: string;
}

@Injectable()
export class ProviderEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProviderEventsService.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly crypto: AesGcmService,
    private readonly config: AppConfigService,
    private readonly lifecycle: AccountLifecycleService,
  ) {}

  onModuleInit(): void {
    if (this.config.nodeEnv === 'test') return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }

  async enqueue(event: VerifiedProviderEvent): Promise<void> {
    const encryptionKey = this.config.adminOtpEncryptionKey;
    if (
      this.config.nodeEnv === 'production' &&
      (encryptionKey.length < 32 ||
        encryptionKey === 'dev-admin-otp-encryption-key-change-me')
    ) {
      throw new ServiceUnavailableException(
        'Provider event storage unavailable',
      );
    }
    const targets: QueuedProviderEventTarget[] = [];
    for (const target of event.targets) {
      const result: unknown = await this.dataSource
        .query(
          `SELECT id, encrypted_revocation_grant AS "encryptedRevocationGrant" FROM social_identities
         WHERE provider = $1 AND provider_client_id = $2 AND subject = $3`,
          [event.provider, target.clientId, target.subject],
        )
        .catch(() => {
          throw new ServiceUnavailableException(
            'Provider event storage unavailable',
          );
        });
      const identity = extractReturnedRow<{
        id: string;
        encryptedRevocationGrant: string | null;
      }>(result);
      targets.push({
        ...target,
        expectedSnapshot: identity
          ? providerEventIdentitySnapshot(identity)
          : null,
      });
    }
    // Kakao has no event ID: fence retries within the observed link/grant generation.
    const deduplicationId =
      event.provider === 'kakao'
        ? JSON.stringify([
            event.deduplicationId,
            targets.map((target) => target.expectedSnapshot),
          ])
        : event.deduplicationId;
    const now = new Date();
    const dedupHash = createHmac('sha256', encryptionKey)
      .update(
        JSON.stringify(['provider-event-v1', event.provider, deduplicationId]),
      )
      .digest('hex');
    const encrypted = this.crypto.encrypt(JSON.stringify(targets));
    // A single committed INSERT is both the dedup fence and the durable work item.
    // No lifecycle work is awaited on the provider's ACK path.
    await this.dataSource
      .query(
        `INSERT INTO provider_events
        (id, provider, dedup_hash, encrypted_target, received_at, expires_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $5)
       ON CONFLICT (provider, dedup_hash) DO NOTHING`,
        [
          randomUUID(),
          event.provider,
          dedupHash,
          encrypted,
          now,
          new Date(now.getTime() + EVENT_TTL_MS),
        ],
      )
      .catch(() => {
        throw new ServiceUnavailableException(
          'Provider event storage unavailable',
        );
      });
  }

  /** Offline tests can drain one durable receipt without starting a timer. */
  async processOnce(): Promise<boolean> {
    const leaseToken = randomUUID();
    const result: unknown = await this.dataSource.query(
      `WITH candidate AS (
         SELECT id FROM provider_events
         WHERE processed_at IS NULL AND next_attempt_at <= now()
           AND (lease_until IS NULL OR lease_until <= now())
         ORDER BY next_attempt_at, received_at
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE provider_events event
       SET lease_token = $1, lease_until = now() + interval '2 minutes',
           attempts = event.attempts + 1
       FROM candidate WHERE event.id = candidate.id
       RETURNING event.id, event.provider, event.encrypted_target, event.attempts, event.lease_token`,
      [leaseToken],
    );
    const claimed = extractReturnedRow<ClaimedEvent>(result);
    if (!claimed) return false;
    try {
      const targets = JSON.parse(
        this.crypto.decrypt(claimed.encrypted_target),
      ) as QueuedProviderEventTarget[];
      for (const target of targets) {
        // A pre-snapshot receipt must remain retryable for repair, never act as an
        // unbound four-argument call against a newly linked identity.
        if (
          target.expectedSnapshot === undefined ||
          (target.expectedSnapshot !== null &&
            (typeof target.expectedSnapshot !== 'object' ||
              typeof target.expectedSnapshot.identityId !== 'string' ||
              !target.expectedSnapshot.identityId ||
              !/^[a-f0-9]{64}$/.test(target.expectedSnapshot.grantDigest)))
        )
          throw new Error('Invalid provider event snapshot');
        await this.lifecycle.consumeProviderEvent(
          claimed.provider,
          target.clientId,
          target.subject,
          target.kind,
          target.expectedSnapshot,
        );
      }
      await this.dataSource.query(
        `UPDATE provider_events SET processed_at = now(), encrypted_target = NULL,
           lease_token = NULL, lease_until = NULL
         WHERE id = $1 AND lease_token = $2 AND processed_at IS NULL`,
        [claimed.id, claimed.lease_token],
      );
    } catch {
      const delaySeconds = Math.min(
        3600,
        5 * 2 ** Math.min(claimed.attempts - 1, 10),
      );
      await this.dataSource.query(
        `UPDATE provider_events
         SET next_attempt_at = now() + ($3 * interval '1 second'),
             lease_token = NULL, lease_until = NULL
         WHERE id = $1 AND lease_token = $2 AND processed_at IS NULL`,
        [claimed.id, claimed.lease_token, delaySeconds],
      );
      // Never log provider payloads, decrypted subjects, or arbitrary exception messages.
      this.logger.warn('Provider event processing deferred');
    }
    return true;
  }

  async purgeProcessed(): Promise<void> {
    await this.dataSource.query(
      'DELETE FROM provider_events WHERE processed_at IS NOT NULL AND expires_at <= now()',
    );
  }

  private tick(): Promise<void> {
    if (!this.active) {
      this.active = this.runTick().finally(() => {
        this.active = undefined;
      });
    }
    return this.active;
  }

  private async runTick(): Promise<void> {
    try {
      // Bound each tick so sustained traffic cannot starve retention/shutdown.
      for (let i = 0; i < 50; i += 1) {
        if (!(await this.processOnce())) break;
      }
      await this.purgeProcessed();
    } catch {
      this.logger.error('Provider event queue unavailable');
    }
  }
}
