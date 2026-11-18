import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import {
  ProviderRevocationJobEntity,
  ProviderRevocationReason,
  ProviderRevocationStatus,
} from '../database/entities/provider-revocation-job.entity';
import { SocialIdentityEntity } from '../database/entities/social-identity.entity';
import { extractReturnedRow } from '../database/pg-returning';
import {
  ProviderRevocationGrant,
  parseGrant,
  usableRefresh,
} from './provider-revocations-grant';
import {
  ProviderRevocationError,
  ProviderRevocationsClient,
} from './provider-revocations.client';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const RETRY_MS = [
  60_000, 300_000, 900_000, 3_600_000, 7_200_000, 14_400_000, 21_600_000,
];
const SAFE_FIELDS = [
  'id',
  'reason',
  'status',
  'attempts',
  'nextAttemptAt',
  'deadlineAt',
  'lastErrorCode',
  'completedAt',
  'createdAt',
  'updatedAt',
] as const;
export type ProviderRevocationJobSummary = Pick<
  ProviderRevocationJobEntity,
  (typeof SAFE_FIELDS)[number]
>;

interface ClaimedJob {
  id: string;
  encrypted_payload: string;
  attempts: number;
  deadline_at: Date | string;
  lease_token: string;
}

@Injectable()
export class ProviderRevocationsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ProviderRevocationsService.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly crypto: AesGcmService,
    private readonly client: ProviderRevocationsClient,
  ) {}

  onModuleInit(): void {
    if (
      process.env.NODE_ENV === 'test' ||
      this.config.get<string>('NODE_ENV') === 'test' ||
      String(
        this.config.get('SOCIAL_REVOCATIONS_ENABLED', 'true'),
      ).toLowerCase() === 'false'
    )
      return;
    this.timer = setInterval(() => this.poll(), 5_000);
    this.timer.unref();
    this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active?.catch(() => undefined);
  }

  mergeGrant(existing: string | null, newEncrypted: string): string {
    try {
      const next = this.decode(newEncrypted);
      if (!existing) return this.crypto.encrypt(JSON.stringify(next));
      const previous = this.decode(existing);
      if (
        previous.provider !== next.provider ||
        previous.clientId !== next.clientId ||
        previous.subject !== next.subject
      )
        throw new Error('Grant identity mismatch');
      if (!next.refreshToken && usableRefresh(previous)) {
        next.refreshToken = previous.refreshToken;
        next.refreshTokenExpiresAt = previous.refreshTokenExpiresAt;
      }
      return this.crypto.encrypt(JSON.stringify(next));
    } catch {
      throw new BadRequestException('Invalid provider revocation grant');
    }
  }

  prepare(identities: SocialIdentityEntity[]): void {
    const providers = new Set<string>();
    for (const identity of identities) {
      try {
        if (!this.client.canRevoke(this.target(identity)))
          providers.add(identity.provider);
      } catch {
        providers.add(identity.provider);
      }
    }
    if (providers.size)
      throw new ConflictException({
        code: 'provider_reauthentication_required',
        message: 'Reconnect the listed social providers before continuing',
        providers: [...providers].sort(),
      });
  }

  async assertConnectionAvailable(
    manager: EntityManager,
    identity: Pick<
      SocialIdentityEntity,
      'provider' | 'providerClientId' | 'subject'
    >,
  ): Promise<void> {
    if (!manager.queryRunner?.isTransactionActive)
      throw new Error(
        'Provider connection checks require the account mutation transaction',
      );
    // The caller holds the lifecycle mutex. An in-flight RPC remains fenced even
    // after its lease/deadline; only the worker's terminal status releases it.
    const result: unknown = await manager.query(
      `SELECT id FROM provider_revocation_jobs
       WHERE status IN ('pending', 'processing', 'retry')
         AND (target_hash = $1 OR target_hash IS NULL OR target_hash = '')
       LIMIT 1`,
      [this.targetHash(identity)],
    );
    if (extractReturnedRow(result))
      throw new ConflictException({
        code: 'provider_connection_pending',
        message:
          'The previous provider disconnection is still pending; try again after it completes',
      });
  }

  async enqueue(
    manager: EntityManager,
    identities: SocialIdentityEntity[],
    reason: ProviderRevocationReason,
  ): Promise<number> {
    this.prepare(identities);
    if (!manager.queryRunner?.isTransactionActive)
      throw new Error(
        'Provider revocations require the account mutation transaction',
      );
    if (reason !== 'unlink' && reason !== 'withdraw')
      throw new BadRequestException('Invalid provider revocation reason');
    const repository = manager.getRepository(ProviderRevocationJobEntity);
    const now = new Date();
    // Resolve every target before any insert; callers own the surrounding account transaction.
    const jobs = identities.map((identity) =>
      repository.create({
        id: randomUUID(),
        reason,
        status: 'pending',
        attempts: 0,
        targetHash: this.targetHash(identity),
        encryptedPayload: this.crypto.encrypt(
          JSON.stringify(this.target(identity)),
        ),
        nextAttemptAt: now,
        deadlineAt: new Date(now.getTime() + RETENTION_MS),
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    if (jobs.length) await repository.save(jobs);
    return jobs.length;
  }

  processOnce(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.processNext().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  async list(
    status?: ProviderRevocationStatus,
    limit = 100,
  ): Promise<ProviderRevocationJobSummary[]> {
    const rows = await this.dataSource
      .getRepository(ProviderRevocationJobEntity)
      .find({
        select: [...SAFE_FIELDS],
        where: status ? { status } : {},
        order: { createdAt: 'DESC' },
        take: Number.isFinite(limit)
          ? Math.max(1, Math.min(100, Math.floor(limit)))
          : 100,
      });
    return rows.map(
      (row) =>
        Object.fromEntries(
          SAFE_FIELDS.map((key) => [key, row[key]]),
        ) as ProviderRevocationJobSummary,
    );
  }

  async retry(id: string): Promise<boolean> {
    // Never restore wiped payloads, extend the deadline, reset attempts or steal an active lease.
    const result: unknown = await this.dataSource.query(
      `
      UPDATE provider_revocation_jobs SET next_attempt_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'retry') AND encrypted_payload IS NOT NULL
        AND attempts < 8 AND deadline_at > now() RETURNING id
    `,
      [id],
    );
    return !!extractReturnedRow(result);
  }

  private poll(): void {
    void this.processOnce().catch(() =>
      this.logger.error('Provider revocation worker failed'),
    );
  }

  private decode(encrypted: string): ProviderRevocationGrant {
    if (typeof encrypted !== 'string' || encrypted.length > 64 * 1024)
      throw new Error('Invalid encrypted grant');
    return parseGrant(this.crypto.decrypt(encrypted));
  }

  private targetHash(
    identity: Pick<
      SocialIdentityEntity,
      'provider' | 'providerClientId' | 'subject'
    >,
  ): string {
    return createHmac(
      'sha256',
      this.config.get<string>(
        'ADMIN_OTP_ENCRYPTION_KEY',
        'dev-admin-otp-encryption-key-change-me',
      ),
    )
      .update(
        JSON.stringify([
          'provider-revocation-target-v1',
          identity.provider,
          identity.providerClientId,
          identity.subject,
        ]),
      )
      .digest('hex');
  }

  private target(identity: SocialIdentityEntity): ProviderRevocationGrant {
    const grant = identity.encryptedRevocationGrant
      ? this.decode(identity.encryptedRevocationGrant)
      : {
          provider: identity.provider,
          clientId: identity.providerClientId,
          subject: identity.subject,
          accessToken: null,
          refreshToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
        };
    if (
      grant.provider !== identity.provider ||
      grant.clientId !== identity.providerClientId ||
      grant.subject !== identity.subject
    )
      throw new Error('Grant identity mismatch');
    // A tokenless target is legitimate only for Kakao's server-side admin-key unlink.
    if (!identity.encryptedRevocationGrant && identity.provider !== 'kakao')
      throw new Error('Missing provider grant');
    return parseGrant(JSON.stringify(grant));
  }

  private async processNext(): Promise<void> {
    await this.dataSource.query(`
      UPDATE provider_revocation_jobs
      SET status = 'manual_required', encrypted_payload = NULL, lease_token = NULL,
          lease_expires_at = NULL, next_attempt_at = NULL, completed_at = now(), updated_at = now(),
          last_error_code = CASE WHEN deadline_at <= now() THEN 'deadline_exceeded' ELSE 'attempts_exhausted' END
      WHERE status IN ('pending', 'retry', 'processing')
        AND (deadline_at <= now() OR (attempts >= 8 AND (lease_expires_at IS NULL OR lease_expires_at <= now())))
    `);
    const result: unknown = await this.dataSource.query(
      `
      WITH candidate AS (
        SELECT id FROM provider_revocation_jobs
        WHERE encrypted_payload IS NOT NULL AND deadline_at > now() AND attempts < 8
          AND ((status IN ('pending', 'retry') AND next_attempt_at <= now())
            OR (status = 'processing' AND lease_expires_at <= now()))
        ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE provider_revocation_jobs job SET status = 'processing', attempts = job.attempts + 1,
        lease_token = $1, lease_expires_at = LEAST(now() + interval '60 seconds', deadline_at), updated_at = now()
      FROM candidate WHERE job.id = candidate.id
      RETURNING job.id, job.encrypted_payload, job.attempts, job.deadline_at, job.lease_token
    `,
      [randomUUID()],
    );
    const claimed = extractReturnedRow<ClaimedJob>(result);
    if (!claimed) return;
    let failure: ProviderRevocationError | undefined;
    let grant: ProviderRevocationGrant | undefined;
    try {
      grant = this.decode(claimed.encrypted_payload);
    } catch {
      failure = new ProviderRevocationError('invalid_grant', true);
    }
    if (grant) {
      try {
        await this.client.revoke(
          grant,
          async (refreshed) => {
            const updated: unknown = await this.dataSource.query(
              `
          UPDATE provider_revocation_jobs SET encrypted_payload = $3, updated_at = now()
          WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND deadline_at > now()
            AND lease_expires_at > now() RETURNING id
        `,
              [
                claimed.id,
                claimed.lease_token,
                this.crypto.encrypt(JSON.stringify(refreshed)),
              ],
            );
            if (!extractReturnedRow(updated))
              throw new ProviderRevocationError('lease_lost', true);
          },
          new Date(claimed.deadline_at).getTime(),
        );
      } catch (error) {
        failure =
          error instanceof ProviderRevocationError
            ? error
            : new ProviderRevocationError('worker_unavailable');
      }
    }
    const expired = new Date(claimed.deadline_at).getTime() <= Date.now();
    const terminal =
      !!failure &&
      (failure.terminal || expired || claimed.attempts >= MAX_ATTEMPTS);
    const status = failure
      ? terminal
        ? 'manual_required'
        : 'retry'
      : 'succeeded';
    const retryAt =
      failure && !terminal
        ? new Date(
            Math.min(
              Date.now() + RETRY_MS[claimed.attempts - 1],
              new Date(claimed.deadline_at).getTime(),
            ),
          )
        : null;
    await this.dataSource.query(
      `
      UPDATE provider_revocation_jobs SET status = $3,
        encrypted_payload = CASE WHEN $3 IN ('succeeded', 'manual_required') THEN NULL ELSE encrypted_payload END,
        next_attempt_at = $4, last_error_code = $5, lease_token = NULL, lease_expires_at = NULL,
        completed_at = CASE WHEN $3 IN ('succeeded', 'manual_required') THEN now() ELSE NULL END, updated_at = now()
      WHERE id = $1 AND lease_token = $2 AND status = 'processing'
        AND (lease_expires_at > now() OR deadline_at <= now())
    `,
      [
        claimed.id,
        claimed.lease_token,
        status,
        retryAt,
        failure
          ? expired
            ? 'deadline_exceeded'
            : claimed.attempts >= MAX_ATTEMPTS
              ? 'attempts_exhausted'
              : failure.code
          : null,
      ],
    );
  }
}
