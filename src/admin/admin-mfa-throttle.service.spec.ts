import { Request } from 'express';
import { DataSource, EntityManager } from 'typeorm';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';
import {
  ADMIN_MFA_ACCOUNT_CHALLENGE_LIMIT,
  ADMIN_MFA_ACCOUNT_FAILURE_LIMIT,
  ADMIN_MFA_IP_CHALLENGE_LIMIT,
  ADMIN_MFA_IP_FAILURE_LIMIT,
  ADMIN_MFA_THROTTLE_WINDOW_MS,
  AdminMfaThrottleService,
} from './admin-mfa-throttle.service';

describe('AdminMfaThrottleService', () => {
  it('persists bounded account failures and blocks the next guess', async () => {
    const harness = setup();

    for (
      let attempt = 1;
      attempt <= ADMIN_MFA_ACCOUNT_FAILURE_LIMIT;
      attempt++
    ) {
      const result = await harness.subject.recordFailure(
        'account-1',
        request('203.0.113.10'),
      );
      expect(result.accountCount).toBe(attempt);
    }

    const blocked = await harness.subject.checkGuessAllowed(
      'account-1',
      request('203.0.113.10'),
    );
    expect(blocked).toMatchObject({
      allowed: false,
      blockedBy: 'account',
      accountCount: ADMIN_MFA_ACCOUNT_FAILURE_LIMIT,
    });

    const bounded = await harness.subject.recordFailure(
      'account-1',
      request('203.0.113.10'),
    );
    expect(bounded.accountCount).toBe(ADMIN_MFA_ACCOUNT_FAILURE_LIMIT);
  });

  it('uses a supplied manager and always locks account before IP', async () => {
    const harness = setup();

    await harness.subject.recordFailure(
      'account-1',
      request('203.0.113.11'),
      harness.manager,
    );

    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [expect.stringContaining('admin-mfa:account:')],
    );
    expect(harness.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [expect.stringContaining('admin-mfa:ip:')],
    );
    expect(harness.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.mfa.failure' }),
      harness.manager,
    );
  });

  it('shares the failure cap across accounts on the same IP', async () => {
    const harness = setup();
    const sharedIp = request('203.0.113.14');

    for (let attempt = 1; attempt <= ADMIN_MFA_IP_FAILURE_LIMIT; attempt++) {
      await harness.subject.recordFailure(`account-${attempt}`, sharedIp);
    }

    await expect(
      harness.subject.checkGuessAllowed('account-over-limit', sharedIp),
    ).resolves.toMatchObject({
      allowed: false,
      blockedBy: 'ip',
      ipCount: ADMIN_MFA_IP_FAILURE_LIMIT,
    });
  });

  it('expires failure buckets after the fixed fifteen-minute window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-16T00:00:00Z'));
    try {
      const harness = setup();
      const source = request('203.0.113.15');
      for (
        let attempt = 0;
        attempt < ADMIN_MFA_ACCOUNT_FAILURE_LIMIT;
        attempt++
      ) {
        await harness.subject.recordFailure('account-1', source);
      }
      await expect(
        harness.subject.checkGuessAllowed('account-1', source),
      ).resolves.toMatchObject({ allowed: false, blockedBy: 'account' });

      jest.advanceTimersByTime(ADMIN_MFA_THROTTLE_WINDOW_MS + 1);
      await expect(
        harness.subject.checkGuessAllowed('account-1', source),
      ).resolves.toMatchObject({
        allowed: true,
        accountCount: 0,
        ipCount: 0,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('allows ten account challenges in the window and rejects the eleventh', async () => {
    const harness = setup();

    for (
      let attempt = 1;
      attempt <= ADMIN_MFA_ACCOUNT_CHALLENGE_LIMIT;
      attempt++
    ) {
      await expect(
        harness.subject.consumeChallengeCreation(
          'account-1',
          request('203.0.113.12'),
        ),
      ).resolves.toMatchObject({ allowed: true, accountCount: attempt });
    }

    await expect(
      harness.subject.consumeChallengeCreation(
        'account-1',
        request('203.0.113.12'),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      kind: 'challenge',
      blockedBy: 'account',
    });
  });

  it('shares the challenge cap across accounts on the same IP', async () => {
    const harness = setup();
    const sharedIp = request('203.0.113.13');

    for (let attempt = 1; attempt <= ADMIN_MFA_IP_CHALLENGE_LIMIT; attempt++) {
      await expect(
        harness.subject.consumeChallengeCreation(
          `account-${attempt}`,
          sharedIp,
        ),
      ).resolves.toMatchObject({ allowed: true, ipCount: attempt });
    }

    await expect(
      harness.subject.consumeChallengeCreation('account-over-limit', sharedIp),
    ).resolves.toMatchObject({
      allowed: false,
      kind: 'challenge',
      blockedBy: 'ip',
    });
  });
});

function setup() {
  const repository = new FakeTokenRecordRepository();
  const query = jest.fn().mockResolvedValue(undefined);
  const manager = {
    query,
    getRepository: jest.fn().mockReturnValue(repository),
  } as unknown as EntityManager;
  const transaction = jest.fn(
    async (work: (activeManager: EntityManager) => Promise<unknown>) =>
      work(manager),
  );
  const dataSource = {
    transaction,
  } as unknown as DataSource;
  const auditRecord = jest.fn().mockResolvedValue(undefined);
  const auditLogs = { record: auditRecord } as unknown as AuditLogsService;
  return {
    subject: new AdminMfaThrottleService(dataSource, auditLogs),
    transaction,
    manager: manager as jest.Mocked<EntityManager>,
    query,
    auditRecord,
  };
}

function request(ip: string): Request {
  return {
    ip,
    header: jest.fn((name: string) =>
      name.toLowerCase() === 'user-agent' ? 'jest' : undefined,
    ),
  } as unknown as Request;
}

class FakeTokenRecordRepository {
  private readonly rows = new Map<string, TokenRecordEntity>();
  private nextId = 1;

  findOneBy(
    input: Partial<TokenRecordEntity>,
  ): Promise<TokenRecordEntity | null> {
    const row = input.tokenHash ? this.rows.get(input.tokenHash) : undefined;
    return Promise.resolve(
      row && (!input.type || row.type === input.type) ? row : null,
    );
  }

  create(input: Partial<TokenRecordEntity>): TokenRecordEntity {
    return {
      id: `token-${this.nextId++}`,
      createdAt: new Date(),
      ...input,
    } as TokenRecordEntity;
  }

  save(row: TokenRecordEntity): Promise<TokenRecordEntity> {
    this.rows.set(row.tokenHash, row);
    return Promise.resolve(row);
  }
}
