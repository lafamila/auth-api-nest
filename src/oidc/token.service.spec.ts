import { TokenService } from './token.service';
import { SigningKeyService } from './signing-key.service';
import { AppConfigService } from '../config/app-config.service';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import { AccountEntity } from '../database/entities/account.entity';
import { OidcClientEntity } from '../database/entities/oidc-client.entity';
import { ServiceEntity } from '../database/entities/service.entity';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { ServicePermissionDefinitionEntity } from '../database/entities/service-permission-definition.entity';
import { SigningKeyEntity } from '../database/entities/signing-key.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { hashToken } from '../common/crypto/token-hash';

const config = {
  issuerUrl: 'http://localhost:3032',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 604800,
  refreshRotationGraceSeconds: 0,
} as AppConfigService;

const account = {
  id: 'account-1',
  loginId: 'teddy',
  email: 'teddy@example.com',
  name: 'Teddy',
} as AccountEntity;

const service = {
  id: 'service-1',
  serviceKey: 'todo',
  permissionSchemaVersion: 3,
} as ServiceEntity;

const client = {
  clientId: 'todo-web',
  service,
} as OidcClientEntity;

const permission = {
  permissionDefinition: {
    key: 'admin',
  } as ServicePermissionDefinitionEntity,
} as AccountServicePermissionEntity;

async function buildSigningKeyService(
  repo = new FakeSigningKeyRepository(),
): Promise<SigningKeyService> {
  const aes = new AesGcmService({
    adminOtpEncryptionKey: 'unit-test-signing-encryption-key',
  } as AppConfigService);
  const signingKeys = new SigningKeyService(repo as never, aes);
  await signingKeys.onModuleInit();
  return signingKeys;
}

describe('TokenService', () => {
  it('issues and rotates refresh tokens by family', async () => {
    const tokenRecords = new FakeTokenRecordRepository();
    const service = new TokenService(
      config,
      await buildSigningKeyService(),
      tokenRecords as never,
    );

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

  it('allows a duplicate refresh within the grace window without revoking the family', async () => {
    const graceConfig = {
      ...config,
      refreshRotationGraceSeconds: 60,
    } as AppConfigService;
    const tokenRecords = new FakeTokenRecordRepository();
    const service = new TokenService(
      graceConfig,
      await buildSigningKeyService(),
      tokenRecords as never,
    );

    const first = await service.issueTokens(account, client, permission);
    const consumed = await service.consumeRefreshToken(first.refresh_token);
    const second = await service.issueTokens(
      account,
      client,
      permission,
      consumed.familyId,
    );

    // Re-presenting the already-used token within grace must not throw.
    const graceConsumed = await service.consumeRefreshToken(
      first.refresh_token,
    );
    expect(graceConsumed.familyId).toBe(consumed.familyId);
    // The family stays alive: the real successor is still consumable.
    const afterGrace = await service.consumeRefreshToken(second.refresh_token);
    expect(afterGrace.accountId).toBe(account.id);
  });

  it('revokes the family when a used token is replayed beyond the grace window', async () => {
    const graceConfig = {
      ...config,
      refreshRotationGraceSeconds: 60,
    } as AppConfigService;
    const tokenRecords = new FakeTokenRecordRepository();
    const service = new TokenService(
      graceConfig,
      await buildSigningKeyService(),
      tokenRecords as never,
    );

    const first = await service.issueTokens(account, client, permission);
    const consumed = await service.consumeRefreshToken(first.refresh_token);
    const second = await service.issueTokens(
      account,
      client,
      permission,
      consumed.familyId,
    );

    // Age the used token past the grace window, then replay it.
    tokenRecords.ageUsedAt(first.refresh_token, 61 * 1000);
    await expect(
      service.consumeRefreshToken(first.refresh_token),
    ).rejects.toThrow('Refresh token reuse detected');
    // The whole family is revoked, so the successor is no longer usable.
    await expect(
      service.consumeRefreshToken(second.refresh_token),
    ).rejects.toThrow('Refresh token reuse detected');
  });

  it('keeps refresh tokens consumable after a service instance restart', async () => {
    const tokenRecords = new FakeTokenRecordRepository();
    const signingKeys = await buildSigningKeyService();
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

    const first = await firstService.issueTokens(account, client, permission);
    const consumed = await secondService.consumeRefreshToken(
      first.refresh_token,
    );

    expect(consumed.accountId).toBe(account.id);
    expect(consumed.clientId).toBe(client.clientId);
  });

  it('falls back to env token TTLs when the client has no override', async () => {
    const tokenService = new TokenService(
      config,
      await buildSigningKeyService(),
      new FakeTokenRecordRepository() as never,
    );
    const tokens = await tokenService.issueTokens(account, client, permission);
    const payload = tokenService.verifyAccessToken(tokens.access_token) as {
      iat: number;
      exp: number;
    };
    expect(tokens.expires_in).toBe(900);
    expect(payload.exp - payload.iat).toBe(900);
  });

  it('applies per-client token TTL overrides over the env defaults', async () => {
    const tokenService = new TokenService(
      config,
      await buildSigningKeyService(),
      new FakeTokenRecordRepository() as never,
    );
    const overrideClient = {
      clientId: 'game-platform-api',
      service,
      accessTokenTtlSeconds: 1800,
      refreshTokenTtlSeconds: 2592000,
    } as OidcClientEntity;

    const tokens = await tokenService.issueTokens(
      account,
      overrideClient,
      permission,
    );
    const payload = tokenService.verifyAccessToken(tokens.access_token) as {
      iat: number;
      exp: number;
    };
    expect(tokens.expires_in).toBe(1800);
    expect(payload.exp - payload.iat).toBe(1800);
  });

  it('reloads the persisted signing key so tokens survive a process restart', async () => {
    const signingKeyRepo = new FakeSigningKeyRepository();
    const firstSigningKeys = await buildSigningKeyService(signingKeyRepo);
    const firstService = new TokenService(
      config,
      firstSigningKeys,
      new FakeTokenRecordRepository() as never,
    );
    const tokens = await firstService.issueTokens(account, client, permission);

    // Simulate a fresh process: a new signing-key service backed by the same
    // persisted rows must load the same kid and still verify the old token.
    const secondSigningKeys = await buildSigningKeyService(signingKeyRepo);
    const secondService = new TokenService(
      config,
      secondSigningKeys,
      new FakeTokenRecordRepository() as never,
    );

    expect(secondSigningKeys.getActiveKey().kid).toBe(
      firstSigningKeys.getActiveKey().kid,
    );
    expect(signingKeyRepo.rows).toHaveLength(1);
    const payload = secondService.verifyAccessToken(tokens.access_token);
    expect(payload.sub).toBe(account.id);
  });

  it('publishes the active key plus retiring keys in the JWKS', async () => {
    const signingKeyRepo = new FakeSigningKeyRepository();
    const active = await buildSigningKeyService(signingKeyRepo);
    const oldToken = await new TokenService(
      config,
      active,
      new FakeTokenRecordRepository() as never,
    ).issueTokens(account, client, permission);

    // Simulate a retired key left in the table from a prior rotation.
    signingKeyRepo.rows[0].active = false;
    const retiringKid = signingKeyRepo.rows[0].kid;
    const rotated = await buildSigningKeyService(signingKeyRepo);
    const rotatedTokenService = new TokenService(
      config,
      rotated,
      new FakeTokenRecordRepository() as never,
    );

    const jwks = rotated.jwks();
    const kids = jwks.keys.map((key) => key.kid);
    expect(signingKeyRepo.rows).toHaveLength(2);
    expect(kids).toContain(retiringKid);
    expect(kids).toContain(rotated.getActiveKey().kid);
    expect(kids).toHaveLength(2);
    // The prior key must still verify tokens it signed.
    expect(
      rotatedTokenService.verifyAccessToken(oldToken.access_token).sub,
    ).toBe(account.id);
  });

  it('issues body-lab access tokens with the service audience and owner claim', async () => {
    const tokenService = new TokenService(
      config,
      await buildSigningKeyService(),
      new FakeTokenRecordRepository() as never,
    );
    const bodyLabClient = {
      clientId: 'body-lab-ios',
      service: {
        id: 'service-1',
        serviceKey: 'body-lab',
        permissionSchemaVersion: 2,
      } as ServiceEntity,
    } as OidcClientEntity;
    const ownerPermission = {
      permissionDefinition: {
        key: 'owner',
      } as ServicePermissionDefinitionEntity,
    } as AccountServicePermissionEntity;

    const tokens = await tokenService.issueTokens(
      account,
      bodyLabClient,
      ownerPermission,
    );
    const payload = tokenService.verifyAccessToken(tokens.access_token);

    expect(payload.aud).toBe('service:body-lab');
    expect(payload.scope).toBe('openid profile email service.permission');
    expect(payload['https://lafamila.xyz/claims/service']).toEqual({
      key: 'body-lab',
      permission: 'owner',
      permissionSchemaVersion: 2,
    });
  });
});

class FakeSigningKeyRepository {
  readonly rows: SigningKeyEntity[] = [];

  async find(): Promise<SigningKeyEntity[]> {
    return [...this.rows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  create(input: Partial<SigningKeyEntity>): SigningKeyEntity {
    return { ...input } as SigningKeyEntity;
  }

  async save(entity: SigningKeyEntity): Promise<SigningKeyEntity> {
    const row = {
      ...entity,
      id: `signing-key-${this.rows.length + 1}`,
      createdAt: new Date(Date.now() + this.rows.length),
    } as SigningKeyEntity;
    this.rows.push(row);
    return row;
  }
}

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
      usedAt: input.usedAt ?? null,
      expiresAt: input.expiresAt as Date,
      createdAt: new Date(),
    });
  }

  ageUsedAt(rawToken: string, ms: number): void {
    const tokenHash = hashToken(rawToken);
    const row = this.rows.find((entry) => entry.tokenHash === tokenHash);
    if (row?.usedAt) {
      row.usedAt = new Date(row.usedAt.getTime() - ms);
    }
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
      return [[], 0];
    }
    row.status = 'used';
    row.usedAt = new Date();
    // Mirror the [rows, affectedCount] shape TypeORM returns for Postgres
    // UPDATE ... RETURNING so the fake matches the real driver contract.
    return [
      [
        {
          account_id: row.accountId,
          client_id: row.clientId,
          family_id: row.familyId,
          status: row.status,
          expires_at: row.expiresAt,
        },
      ],
      1,
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
