import { AuthorizationCodeService } from './authorization-code.service';
import { hashToken } from '../common/crypto/token-hash';
import { AccountEntity } from '../database/entities/account.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { DataSource, EntityManager } from 'typeorm';

describe('AuthorizationCodeService', () => {
  const input = {
    accountId: 'account-1',
    clientId: 'client-1',
    redirectUri: 'http://localhost/callback',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256' as const,
    scope: 'openid',
    nonce: 'appauth-generated-nonce',
    credentialVersion: 3,
    authenticationMethod: 'google' as const,
  };

  it('consumes authorization codes only once', async () => {
    const { service } = setup();
    const code = await service.create(input);

    const first = await service.consume(code);
    expect(first?.accountId).toBe('account-1');
    expect(first?.redirectUri).toBe('http://localhost/callback');
    expect(first?.codeChallenge).toBe('challenge');
    expect(first?.nonce).toBe('appauth-generated-nonce');
    expect(first?.credentialVersion).toBe(3);
    expect(first?.authenticationMethod).toBe('google');
    expect(await service.consume(code)).toBeNull();
  });

  it('rejects expired authorization codes', async () => {
    const { repo, service } = setup();
    const code = await service.create(input);
    repo.expire(code);
    expect(await service.consume(code)).toBeNull();
  });

  it('does not infer a method for legacy or malformed provenance', async () => {
    const { service } = setup();
    const code = await service.create({
      ...input,
      authenticationMethod: undefined,
    });
    expect((await service.consume(code))?.authenticationMethod).toBe('legacy');
  });

  it('locks the account before storing its credential version snapshot', async () => {
    const { events, service } = setup({ credentialVersion: 7 });
    const code = await service.create({ ...input, credentialVersion: 7 });

    expect(events).toEqual(['account-lock', 'code-insert']);
    expect((await service.findActive(code))?.credentialVersion).toBe(7);
  });

  it('does not issue a code when credentials change before the account lock', async () => {
    const { events, repo, service } = setup({ credentialVersion: 4 });

    await expect(service.create(input)).rejects.toThrow(
      'Account credentials changed before authorization code issuance',
    );
    expect(events).toEqual(['account-lock']);
    expect(repo.size).toBe(0);
  });

  it.each([
    { status: 'disabled', passwordResetRequired: false },
    { status: 'active', passwordResetRequired: true },
  ] as const)(
    'does not issue a code for an unavailable account %#',
    async ({ status, passwordResetRequired }) => {
      const { repo, service } = setup({ status, passwordResetRequired });

      await expect(service.create(input)).rejects.toThrow(
        'Account credentials changed before authorization code issuance',
      );
      expect(repo.size).toBe(0);
    },
  );

  it('accepts legacy codes only while the locked account is version zero', () => {
    const { service } = setup();
    const legacy = {
      accountId: input.accountId,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      scope: input.scope,
      nonce: input.nonce,
      expiresAt: new Date(Date.now() + 1000),
    };

    expect(
      service.isCurrentCredential(legacy, {
        credentialVersion: 0,
      } as AccountEntity),
    ).toBe(true);
    expect(
      service.isCurrentCredential(legacy, {
        credentialVersion: 1,
      } as AccountEntity),
    ).toBe(false);
  });

  function setup(accountOverrides: Partial<AccountEntity> = {}) {
    const events: string[] = [];
    const repo = new FakeAuthorizationCodeRepository(events);
    const account = {
      id: input.accountId,
      status: 'active',
      passwordResetRequired: false,
      credentialVersion: 3,
      ...accountOverrides,
    } as AccountEntity;
    const accountRepository = {
      findOne: jest.fn().mockImplementation(async (options) => {
        expect(options).toEqual({
          where: { id: input.accountId },
          lock: { mode: 'pessimistic_write' },
        });
        events.push('account-lock');
        return account;
      }),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity === AccountEntity ? accountRepository : repo,
      ),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(
        async (callback: (transaction: EntityManager) => Promise<unknown>) =>
          callback(manager),
      ),
    } as unknown as DataSource;
    return {
      events,
      repo,
      service: new AuthorizationCodeService(repo as never, dataSource),
    };
  }
});

class FakeAuthorizationCodeRepository {
  private readonly rows: TokenRecordEntity[] = [];

  constructor(private readonly events: string[]) {}

  get size(): number {
    return this.rows.length;
  }

  async insert(input: Partial<TokenRecordEntity>): Promise<void> {
    this.events.push('code-insert');
    this.rows.push({ ...input } as TokenRecordEntity);
  }

  async findOne(input: {
    where: { tokenHash: string; type: string; status: string };
  }): Promise<TokenRecordEntity | null> {
    return (
      this.rows.find(
        (entry) =>
          entry.tokenHash === input.where.tokenHash &&
          entry.type === input.where.type &&
          entry.status === input.where.status &&
          entry.expiresAt.getTime() > Date.now(),
      ) ?? null
    );
  }

  expire(code: string): void {
    const row = this.rows.find((entry) => entry.tokenHash === hashToken(code));
    if (row) {
      row.expiresAt = new Date(Date.now() - 1000);
    }
  }

  async query(_sql: string, params: unknown[]): Promise<unknown[]> {
    const tokenHash = params[0] as string;
    const index = this.rows.findIndex(
      (entry) =>
        entry.tokenHash === tokenHash &&
        entry.type === 'authorization_code' &&
        entry.status === 'active' &&
        entry.expiresAt.getTime() > Date.now(),
    );
    if (index === -1) {
      return [[], 0];
    }
    const [row] = this.rows.splice(index, 1);
    // Mirror TypeORM's [rows, affectedCount] shape for DELETE ... RETURNING.
    return [
      [
        {
          account_id: row.accountId,
          client_id: row.clientId,
          metadata_json: row.metadataJson,
          expires_at: row.expiresAt,
        },
      ],
      1,
    ];
  }
}
