import { TokenService } from './token.service';
import { SigningKeyService } from './signing-key.service';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { OidcClientEntity } from '../database/entities/oidc-client.entity';
import { ServiceEntity } from '../database/entities/service.entity';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { ServicePermissionDefinitionEntity } from '../database/entities/service-permission-definition.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';

const config = {
  issuerUrl: 'http://localhost:3032',
} as AppConfigService;

describe('TokenService', () => {
  it('issues and rotates refresh tokens by family', async () => {
    const tokenRecords = new FakeTokenRecordRepository();
    const service = new TokenService(
      config,
      new SigningKeyService(),
      tokenRecords as never,
    );
    const account = {
      id: 'account-1',
      loginId: 'teddy',
      email: 'teddy@example.com',
      name: 'Teddy',
    } as AccountEntity;
    const app = {
      id: 'service-1',
      serviceKey: 'todo',
      permissionSchemaVersion: 3,
    } as ServiceEntity;
    const client = {
      clientId: 'todo-web',
      service: app,
    } as OidcClientEntity;
    const permission = {
      permissionDefinition: {
        key: 'admin',
      } as ServicePermissionDefinitionEntity,
    } as AccountServicePermissionEntity;

    const first = await service.issueTokens(account, client, permission);
    const consumed = await service.consumeRefreshToken(first.refresh_token);
    const second = await service.issueTokens(
      account,
      client,
      permission,
      consumed.familyId,
    );

    expect(first.access_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    await expect(
      service.consumeRefreshToken(first.refresh_token),
    ).rejects.toThrow('Refresh token reuse detected');
  });

  it('keeps refresh tokens consumable after a service instance restart', async () => {
    const tokenRecords = new FakeTokenRecordRepository();
    const signingKeys = new SigningKeyService();
    const firstService = new TokenService(
      config,
      signingKeys,
      tokenRecords as never,
    );
    const secondService = new TokenService(
      config,
      signingKeys,
      tokenRecords as never,
    );
    const account = {
      id: 'account-1',
      loginId: 'teddy',
      email: 'teddy@example.com',
      name: 'Teddy',
    } as AccountEntity;
    const app = {
      id: 'service-1',
      serviceKey: 'todo',
      permissionSchemaVersion: 3,
    } as ServiceEntity;
    const client = {
      clientId: 'todo-web',
      service: app,
    } as OidcClientEntity;
    const permission = {
      permissionDefinition: {
        key: 'admin',
      } as ServicePermissionDefinitionEntity,
    } as AccountServicePermissionEntity;

    const first = await firstService.issueTokens(account, client, permission);
    const consumed = await secondService.consumeRefreshToken(
      first.refresh_token,
    );

    expect(consumed.accountId).toBe(account.id);
    expect(consumed.clientId).toBe(client.clientId);
  });

  it('issues body-lab access tokens with the service audience and owner claim', async () => {
    const service = new TokenService(
      config,
      new SigningKeyService(),
      new FakeTokenRecordRepository() as never,
    );
    const account = {
      id: 'account-1',
      loginId: 'teddy',
      email: 'teddy@example.com',
      name: 'Teddy',
    } as AccountEntity;
    const app = {
      id: 'service-1',
      serviceKey: 'body-lab',
      permissionSchemaVersion: 2,
    } as ServiceEntity;
    const client = {
      clientId: 'body-lab-ios',
      service: app,
    } as OidcClientEntity;
    const permission = {
      permissionDefinition: {
        key: 'owner',
      } as ServicePermissionDefinitionEntity,
    } as AccountServicePermissionEntity;

    const tokens = await service.issueTokens(account, client, permission);
    const payload = service.verifyAccessToken(tokens.access_token);

    expect(payload.aud).toBe('service:body-lab');
    expect(payload.scope).toBe('openid profile email service.permission');
    expect(payload['https://lafamila.xyz/claims/service']).toEqual({
      key: 'body-lab',
      permission: 'owner',
      permissionSchemaVersion: 2,
    });
  });
});

class FakeTokenRecordRepository {
  private readonly rows: TokenRecordEntity[] = [];

  async insert(input: Partial<TokenRecordEntity>): Promise<void> {
    this.rows.push({
      id: `token-${this.rows.length + 1}`,
      tokenHash: input.tokenHash as string,
      type: input.type ?? 'refresh_token',
      status: input.status ?? 'active',
      familyId: input.familyId ?? null,
      accountId: input.accountId as string,
      clientId: input.clientId as string,
      serviceId: input.serviceId ?? null,
      metadataJson: input.metadataJson ?? null,
      expiresAt: input.expiresAt as Date,
      createdAt: new Date(),
    });
  }

  async query(_sql: string, params: unknown[]): Promise<unknown[]> {
    const tokenHash = params[0] as string;
    const row = this.rows.find(
      (entry) =>
        entry.tokenHash === tokenHash &&
        entry.type === 'refresh_token' &&
        entry.status === 'active' &&
        entry.expiresAt.getTime() > Date.now(),
    );
    if (!row) {
      return [];
    }
    row.status = 'used';
    return [
      {
        account_id: row.accountId,
        client_id: row.clientId,
        family_id: row.familyId,
        status: row.status,
        expires_at: row.expiresAt,
      },
    ];
  }

  async findOne(input: {
    where: { tokenHash: string; type: string };
  }): Promise<TokenRecordEntity | null> {
    return (
      this.rows.find(
        (row) =>
          row.tokenHash === input.where.tokenHash &&
          row.type === input.where.type,
      ) ?? null
    );
  }

  async update(
    criteria: Partial<TokenRecordEntity>,
    patch: Partial<TokenRecordEntity>,
  ): Promise<void> {
    for (const row of this.rows) {
      if (
        (criteria.tokenHash === undefined ||
          row.tokenHash === criteria.tokenHash) &&
        (criteria.type === undefined || row.type === criteria.type) &&
        (criteria.familyId === undefined || row.familyId === criteria.familyId)
      ) {
        Object.assign(row, patch);
      }
    }
  }
}
