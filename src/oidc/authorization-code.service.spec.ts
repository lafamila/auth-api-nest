import { AuthorizationCodeService } from './authorization-code.service';
import { hashToken } from '../common/crypto/token-hash';
import { TokenRecordEntity } from '../database/entities/token-record.entity';

describe('AuthorizationCodeService', () => {
  const input = {
    accountId: 'account-1',
    clientId: 'client-1',
    redirectUri: 'http://localhost/callback',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256' as const,
    scope: 'openid',
  };

  it('consumes authorization codes only once', async () => {
    const repo = new FakeAuthorizationCodeRepository();
    const service = new AuthorizationCodeService(repo as never);
    const code = await service.create(input);

    const first = await service.consume(code);
    expect(first?.accountId).toBe('account-1');
    expect(first?.redirectUri).toBe('http://localhost/callback');
    expect(first?.codeChallenge).toBe('challenge');
    expect(await service.consume(code)).toBeNull();
  });

  it('rejects expired authorization codes', async () => {
    const repo = new FakeAuthorizationCodeRepository();
    const service = new AuthorizationCodeService(repo as never);
    const code = await service.create(input);
    repo.expire(code);
    expect(await service.consume(code)).toBeNull();
  });
});

class FakeAuthorizationCodeRepository {
  private readonly rows: TokenRecordEntity[] = [];

  async insert(input: Partial<TokenRecordEntity>): Promise<void> {
    this.rows.push({ ...input } as TokenRecordEntity);
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
