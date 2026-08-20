import { hashToken } from '../common/crypto/token-hash';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { AuthorizeRequestInput } from './authorize-flow.service';
import { HostedLoginTransactionService } from './hosted-login-transaction.service';

describe('HostedLoginTransactionService', () => {
  const request: AuthorizeRequestInput = {
    clientId: 'gbc-porting-web',
    redirectUri: 'https://play.example.com/session/oidc/callback',
    responseType: 'code',
    scope: 'openid profile email service.permission',
    state: 'player-2-state',
    codeChallenge: 'pkce-challenge',
    codeChallengeMethod: 'S256',
    prompt: 'select_account',
  };
  let repository: FakeHostedLoginTransactionRepository;
  let service: HostedLoginTransactionService;

  beforeEach(() => {
    repository = new FakeHostedLoginTransactionRepository();
    service = new HostedLoginTransactionService(repository as never);
  });

  it('stores only hashes and restores the canonical authorize request', async () => {
    const created = await service.create({
      request,
      sessionAccountId: 'p1-account',
    });

    expect(repository.rows[0].tokenHash).toBe(hashToken(created.id));
    expect(repository.rows[0].tokenHash).not.toContain(created.id);
    expect(repository.rows[0].metadataJson).toEqual(
      expect.objectContaining({
        browserBindingHash: hashToken(created.browserNonce),
      }),
    );
    expect(JSON.stringify(repository.rows[0])).not.toContain(
      created.browserNonce,
    );
    await expect(
      service.find(created.id, created.browserNonce),
    ).resolves.toEqual(
      expect.objectContaining({
        request,
        sessionAccountId: 'p1-account',
      }),
    );
  });

  it('supports concurrent transactions and consumes each exactly once', async () => {
    const first = await service.create({ request, sessionAccountId: null });
    const second = await service.create({
      request: { ...request, state: 'second-state' },
      sessionAccountId: null,
    });

    await expect(
      service.consume(second.id, second.browserNonce),
    ).resolves.toEqual(
      expect.objectContaining({
        request: expect.objectContaining({ state: 'second-state' }),
      }),
    );
    await expect(
      service.consume(first.id, first.browserNonce),
    ).resolves.toEqual(
      expect.objectContaining({
        request: expect.objectContaining({ state: 'player-2-state' }),
      }),
    );
    await expect(
      service.consume(first.id, first.browserNonce),
    ).resolves.toBeNull();
  });

  it('does not expose or consume a transaction with the wrong browser binding', async () => {
    const created = await service.create({ request, sessionAccountId: null });

    await expect(service.find(created.id, 'wrong-browser')).resolves.toBeNull();
    await expect(
      service.consume(created.id, 'wrong-browser'),
    ).resolves.toBeNull();
    await expect(
      service.consume(created.id, created.browserNonce),
    ).resolves.not.toBeNull();
  });

  it('rejects expired transactions without consuming another transaction', async () => {
    const expired = await service.create({ request, sessionAccountId: null });
    const active = await service.create({ request, sessionAccountId: null });
    repository.expire(expired.id);

    await expect(
      service.find(expired.id, expired.browserNonce),
    ).resolves.toBeNull();
    await expect(
      service.consume(expired.id, expired.browserNonce),
    ).resolves.toBeNull();
    await expect(
      service.consume(active.id, active.browserNonce),
    ).resolves.not.toBeNull();
  });
});

class FakeHostedLoginTransactionRepository {
  readonly rows: TokenRecordEntity[] = [];

  async insert(input: Partial<TokenRecordEntity>): Promise<void> {
    this.rows.push({ ...input } as TokenRecordEntity);
  }

  expire(id: string): void {
    const row = this.rows.find((entry) => entry.tokenHash === hashToken(id));
    if (row) {
      row.expiresAt = new Date(Date.now() - 1000);
    }
  }

  async query(sql: string, params: unknown[]): Promise<unknown> {
    const [tokenHash, browserBindingHash] = params as [string, string];
    const index = this.rows.findIndex(
      (entry) =>
        entry.tokenHash === tokenHash &&
        entry.type === 'authorization_login' &&
        entry.status === 'active' &&
        entry.expiresAt.getTime() > Date.now() &&
        entry.metadataJson?.browserBindingHash === browserBindingHash,
    );
    if (index === -1) {
      return sql.includes('DELETE') ? [[], 0] : [];
    }
    const row = this.rows[index];
    const returned = {
      account_id: row.accountId,
      client_id: row.clientId,
      metadata_json: row.metadataJson,
      expires_at: row.expiresAt,
    };
    if (!sql.includes('DELETE')) {
      return [returned];
    }
    this.rows.splice(index, 1);
    return [[returned], 1];
  }
}
