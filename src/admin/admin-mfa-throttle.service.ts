import { Injectable } from '@nestjs/common';
import { Request } from 'express';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { hashToken } from '../common/crypto/token-hash';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';

export const ADMIN_MFA_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const ADMIN_MFA_ACCOUNT_FAILURE_LIMIT = 5;
export const ADMIN_MFA_IP_FAILURE_LIMIT = 30;
export const ADMIN_MFA_ACCOUNT_CHALLENGE_LIMIT = 10;
export const ADMIN_MFA_IP_CHALLENGE_LIMIT = 30;

type ThrottleKind = 'failure' | 'challenge';
type ThrottleScope = 'account' | 'ip';

export interface AdminMfaThrottleResult {
  allowed: boolean;
  kind: ThrottleKind;
  blockedBy: ThrottleScope | null;
  accountCount: number;
  accountLimit: number;
  ipCount: number;
  ipLimit: number;
  retryAt: Date | null;
}

interface ThrottleBucket {
  count: number;
  expiresAt: Date;
}

const THROTTLE_CLIENT_ID = 'admin-mfa-throttle';

@Injectable()
export class AdminMfaThrottleService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogs: AuditLogsService,
  ) {}

  checkGuessAllowed(
    accountId: string,
    request: Request,
    manager?: EntityManager,
  ): Promise<AdminMfaThrottleResult> {
    return this.withManager(manager, async (activeManager) => {
      const ip = this.ipAddress(request);
      await this.lock(activeManager, accountId, ip);
      return this.readResult(activeManager, 'failure', accountId, ip);
    });
  }

  recordFailure(
    accountId: string,
    request: Request,
    manager?: EntityManager,
  ): Promise<AdminMfaThrottleResult> {
    return this.withManager(manager, async (activeManager) => {
      const ip = this.ipAddress(request);
      await this.lock(activeManager, accountId, ip);
      const account = await this.increment(
        activeManager,
        'failure',
        'account',
        accountId,
        accountId,
        ADMIN_MFA_ACCOUNT_FAILURE_LIMIT,
      );
      const ipBucket = await this.increment(
        activeManager,
        'failure',
        'ip',
        ip,
        null,
        ADMIN_MFA_IP_FAILURE_LIMIT,
      );
      const result = this.result(
        'failure',
        account,
        ADMIN_MFA_ACCOUNT_FAILURE_LIMIT,
        ipBucket,
        ADMIN_MFA_IP_FAILURE_LIMIT,
      );
      await this.auditLogs.record(
        {
          actorAccountId: accountId,
          action: 'admin.mfa.failure',
          targetType: 'account',
          targetId: accountId,
          afterJson: this.auditDetails(result),
          ipAddress: ip,
          userAgent: request.header('user-agent') ?? null,
        },
        activeManager,
      );
      return result;
    });
  }

  consumeChallengeCreation(
    accountId: string,
    request: Request,
  ): Promise<AdminMfaThrottleResult> {
    return this.dataSource.transaction(async (manager) => {
      const ip = this.ipAddress(request);
      await this.lock(manager, accountId, ip);
      const failures = await this.readResult(manager, 'failure', accountId, ip);
      if (!failures.allowed) return failures;

      const current = await this.readResult(
        manager,
        'challenge',
        accountId,
        ip,
      );
      if (!current.allowed) return current;

      const account = await this.increment(
        manager,
        'challenge',
        'account',
        accountId,
        accountId,
        ADMIN_MFA_ACCOUNT_CHALLENGE_LIMIT,
      );
      const ipBucket = await this.increment(
        manager,
        'challenge',
        'ip',
        ip,
        null,
        ADMIN_MFA_IP_CHALLENGE_LIMIT,
      );
      const consumed = this.result(
        'challenge',
        account,
        ADMIN_MFA_ACCOUNT_CHALLENGE_LIMIT,
        ipBucket,
        ADMIN_MFA_IP_CHALLENGE_LIMIT,
      );
      return {
        ...consumed,
        allowed: true,
        blockedBy: null,
        retryAt: null,
      };
    });
  }

  async auditBlocked(
    accountId: string,
    request: Request,
    result: AdminMfaThrottleResult,
  ): Promise<void> {
    await this.auditLogs.record({
      actorAccountId: accountId,
      action: 'admin.mfa.throttled',
      targetType: 'account',
      targetId: accountId,
      afterJson: this.auditDetails(result),
      ipAddress: this.ipAddress(request),
      userAgent: request.header('user-agent') ?? null,
    });
  }

  ipAddress(request: Request): string {
    const forwarded = request.header('x-forwarded-for')?.split(',')[0]?.trim();
    return (forwarded || request.ip || 'unknown').slice(0, 255);
  }

  private withManager<T>(
    manager: EntityManager | undefined,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return manager ? work(manager) : this.dataSource.transaction(work);
  }

  private async lock(
    manager: EntityManager,
    accountId: string,
    ip: string,
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`admin-mfa:account:${hashToken(accountId)}`],
    );
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`admin-mfa:ip:${hashToken(ip)}`],
    );
  }

  private async readResult(
    manager: EntityManager,
    kind: ThrottleKind,
    accountId: string,
    ip: string,
  ): Promise<AdminMfaThrottleResult> {
    const repository = manager.getRepository(TokenRecordEntity);
    const account = await this.readBucket(
      repository,
      kind,
      'account',
      accountId,
    );
    const ipBucket = await this.readBucket(repository, kind, 'ip', ip);
    const accountLimit =
      kind === 'failure'
        ? ADMIN_MFA_ACCOUNT_FAILURE_LIMIT
        : ADMIN_MFA_ACCOUNT_CHALLENGE_LIMIT;
    const ipLimit =
      kind === 'failure'
        ? ADMIN_MFA_IP_FAILURE_LIMIT
        : ADMIN_MFA_IP_CHALLENGE_LIMIT;
    return this.result(kind, account, accountLimit, ipBucket, ipLimit);
  }

  private async readBucket(
    repository: Repository<TokenRecordEntity>,
    kind: ThrottleKind,
    scope: ThrottleScope,
    key: string,
  ): Promise<ThrottleBucket> {
    const row = await repository.findOneBy({
      tokenHash: this.bucketHash(kind, scope, key),
      type: 'admin_mfa_throttle',
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      return { count: 0, expiresAt: new Date(0) };
    }
    return {
      count: this.count(row.metadataJson?.count),
      expiresAt: row.expiresAt,
    };
  }

  private async increment(
    manager: EntityManager,
    kind: ThrottleKind,
    scope: ThrottleScope,
    key: string,
    accountId: string | null,
    limit: number,
  ): Promise<ThrottleBucket> {
    const repository = manager.getRepository(TokenRecordEntity);
    const tokenHash = this.bucketHash(kind, scope, key);
    let row = await repository.findOneBy({
      tokenHash,
      type: 'admin_mfa_throttle',
    });
    const now = Date.now();
    const activeRow = row && row.expiresAt.getTime() > now ? row : null;
    const count = Math.min(
      (activeRow ? this.count(activeRow.metadataJson?.count) : 0) + 1,
      limit,
    );
    const expiresAt =
      activeRow?.expiresAt ?? new Date(now + ADMIN_MFA_THROTTLE_WINDOW_MS);
    if (!row) {
      row = repository.create({
        tokenHash,
        type: 'admin_mfa_throttle',
        status: 'active',
        familyId: null,
        accountId,
        clientId: THROTTLE_CLIENT_ID,
        serviceId: null,
        metadataJson: { kind, scope, count },
        usedAt: null,
        expiresAt,
      });
    } else {
      row.status = 'active';
      row.accountId = accountId;
      row.metadataJson = { kind, scope, count };
      row.expiresAt = expiresAt;
    }
    await repository.save(row);
    return { count, expiresAt };
  }

  private result(
    kind: ThrottleKind,
    account: ThrottleBucket,
    accountLimit: number,
    ip: ThrottleBucket,
    ipLimit: number,
  ): AdminMfaThrottleResult {
    const blockedBy =
      account.count >= accountLimit
        ? 'account'
        : ip.count >= ipLimit
          ? 'ip'
          : null;
    return {
      allowed: blockedBy === null,
      kind,
      blockedBy,
      accountCount: account.count,
      accountLimit,
      ipCount: ip.count,
      ipLimit,
      retryAt:
        blockedBy === 'account'
          ? account.expiresAt
          : blockedBy === 'ip'
            ? ip.expiresAt
            : null,
    };
  }

  private bucketHash(
    kind: ThrottleKind,
    scope: ThrottleScope,
    key: string,
  ): string {
    return hashToken(`admin-mfa-throttle:${kind}:${scope}:${key}`);
  }

  private count(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : 0;
  }

  private auditDetails(
    result: AdminMfaThrottleResult,
  ): Record<string, unknown> {
    return {
      kind: result.kind,
      blockedBy: result.blockedBy,
      accountCount: result.accountCount,
      accountLimit: result.accountLimit,
      ipCount: result.ipCount,
      ipLimit: result.ipLimit,
      retryAt: result.retryAt?.toISOString() ?? null,
    };
  }
}
