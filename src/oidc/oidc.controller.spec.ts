import { AppConfigService } from '../config/app-config.service';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { AccountEntity } from '../database/entities/account.entity';
import { OidcClientEntity } from '../database/entities/oidc-client.entity';
import { ServicePermissionDefinitionEntity } from '../database/entities/service-permission-definition.entity';
import { AccountPermissionsService } from '../domain/account-permissions/account-permissions.service';
import { AccountsService } from '../domain/accounts/accounts.service';
import { OidcClientsService } from '../domain/oidc-clients/oidc-clients.service';
import { OAuthError } from './oauth-error';
import { OidcController } from './oidc.controller';
import { TokenService } from './token.service';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

describe('OidcController refresh grant permissions', () => {
  const account = {
    id: 'account-1',
    status: 'active',
    passwordResetRequired: false,
    credentialVersion: 3,
  } as AccountEntity;
  const client = {
    clientId: 'game-platform-api',
    status: 'active',
    serviceId: 'service-game',
    service: {
      id: 'service-game',
      serviceKey: 'game-platform',
      status: 'active',
    },
  } as OidcClientEntity;

  it('passes the authorization nonce into the initial ID token issuance', async () => {
    const currentPermission = {
      permissionDefinition: {
        key: 'superadmin',
      } as ServicePermissionDefinitionEntity,
    } as AccountServicePermissionEntity;
    const { controller, codes, tokens } = setup(currentPermission);
    const verifier = 'a'.repeat(43);
    const storedCode = {
      accountId: account.id,
      clientId: client.clientId,
      redirectUri: 'xyz.lafamila.not:/oauth/callback',
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
      scope: 'openid profile email service.permission',
      nonce: 'appauth-generated-nonce',
      credentialVersion: 3,
      expiresAt: new Date(Date.now() + 60_000),
    };
    codes.findActive.mockResolvedValue(storedCode);
    codes.consume.mockResolvedValue(storedCode);

    await controller.token({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: 'authorization-code',
      redirect_uri: 'xyz.lafamila.not:/oauth/callback',
      code_verifier: verifier,
    });

    expect(tokens.issueTokens).toHaveBeenCalledWith(
      account,
      client,
      currentPermission,
      undefined,
      'appauth-generated-nonce',
      expect.anything(),
    );
  });

  it('mints the refreshed access token from the current changed permission', async () => {
    const currentPermission = {
      permissionDefinition: {
        key: 'admin',
      } as ServicePermissionDefinitionEntity,
    } as AccountServicePermissionEntity;
    const { controller, events, manager, tokens, permissions } =
      setup(currentPermission);

    await expect(
      controller.token({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: 'stored-refresh-token',
      }),
    ).resolves.toEqual({ access_token: 'new-access-token' });

    expect(
      permissions.findActiveOrCreateVisitorForFirstLogin,
    ).toHaveBeenCalledWith(account.id, client.serviceId);
    expect(tokens.issueTokens).toHaveBeenCalledWith(
      account,
      client,
      currentPermission,
      'refresh-family',
      undefined,
      manager,
    );
    expect(events).toEqual(['account-lock', 'refresh-consume', 'token-issue']);
  });

  it('refuses refresh when the service permission has been revoked', async () => {
    const { controller, tokens } = setup(null);

    await expect(
      controller.token({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: 'stored-refresh-token',
      }),
    ).rejects.toMatchObject<Partial<OAuthError>>({
      error: 'access_denied',
      statusCode: 403,
    });
    expect(tokens.issueTokens).not.toHaveBeenCalled();
  });

  it('rejects a stale authorization code after locking the account', async () => {
    const currentPermission = {
      permissionDefinition: { key: 'admin' },
    } as AccountServicePermissionEntity;
    const { controller, codes, tokens } = setup(currentPermission);
    const verifier = 'a'.repeat(43);
    const storedCode = {
      accountId: account.id,
      clientId: client.clientId,
      redirectUri: 'xyz.lafamila.not:/oauth/callback',
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256' as const,
      scope: 'openid',
      credentialVersion: 2,
      expiresAt: new Date(Date.now() + 60_000),
    };
    codes.findActive.mockResolvedValue(storedCode);
    codes.consume.mockResolvedValue(storedCode);
    codes.isCurrentCredential.mockReturnValue(false);

    await expect(
      controller.token({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        code: 'authorization-code',
        redirect_uri: storedCode.redirectUri,
        code_verifier: verifier,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(tokens.issueTokens).not.toHaveBeenCalled();
  });

  it('revokes a stale refresh family without inserting a successor', async () => {
    const currentPermission = {
      permissionDefinition: { key: 'admin' },
    } as AccountServicePermissionEntity;
    const { controller, manager, tokens } = setup(currentPermission);
    tokens.isCurrentCredential.mockReturnValue(false);

    await expect(
      controller.token({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: 'stored-refresh-token',
      }),
    ).rejects.toThrow('Invalid refresh token');

    expect(tokens.revokeFamily).toHaveBeenCalledWith('refresh-family', manager);
    expect(tokens.issueTokens).not.toHaveBeenCalled();
  });

  it('commits refresh-family reuse handling before returning its error', async () => {
    const currentPermission = {
      permissionDefinition: { key: 'admin' },
    } as AccountServicePermissionEntity;
    const { controller, transactionState, tokens } = setup(currentPermission);
    tokens.consumeRefreshTokenForRotation.mockResolvedValue({ kind: 'reuse' });

    await expect(
      controller.token({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: 'reused-refresh-token',
      }),
    ).rejects.toThrow('Refresh token reuse detected');

    expect(transactionState.commits).toBe(1);
    expect(tokens.issueTokens).not.toHaveBeenCalled();
  });

  function setup(currentPermission: AccountServicePermissionEntity | null) {
    const events: string[] = [];
    const transactionState = { commits: 0 };
    const permissions = {
      findActiveOrCreateVisitorForFirstLogin: jest
        .fn()
        .mockResolvedValue(currentPermission),
    };
    const accounts = {
      findById: jest.fn().mockResolvedValue(account),
    };
    const clients = {
      findByClientId: jest.fn().mockResolvedValue(client),
      validateClientSecret: jest.fn().mockResolvedValue(undefined),
    };
    const tokens = {
      getRefreshTokenAccountId: jest.fn().mockResolvedValue({
        accountId: account.id,
        clientId: client.clientId,
      }),
      consumeRefreshTokenForRotation: jest.fn().mockImplementation(async () => {
        events.push('refresh-consume');
        return {
          kind: 'consumed',
          refresh: {
            accountId: account.id,
            clientId: client.clientId,
            familyId: 'refresh-family',
            credentialVersion: 3,
          },
        };
      }),
      isCurrentCredential: jest.fn().mockReturnValue(true),
      revokeFamily: jest.fn().mockResolvedValue(undefined),
      issueTokens: jest.fn().mockImplementation(async () => {
        events.push('token-issue');
        return { access_token: 'new-access-token' };
      }),
    };
    const codes = {
      findActive: jest.fn(),
      consume: jest.fn(),
      isCurrentCredential: jest.fn().mockReturnValue(true),
    };
    const accountRepository = {
      findOne: jest.fn().mockImplementation(async () => {
        events.push('account-lock');
        return account;
      }),
    };
    const permissionRepository = {
      findOne: jest.fn().mockResolvedValue(currentPermission),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity === AccountEntity ? accountRepository : permissionRepository,
      ),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(
        async (callback: (transaction: EntityManager) => Promise<unknown>) => {
          const result = await callback(manager);
          transactionState.commits += 1;
          return result;
        },
      ),
    } as unknown as DataSource;
    const controller = new OidcController(
      {} as AppConfigService,
      permissions as unknown as AccountPermissionsService,
      accounts as unknown as AccountsService,
      clients as unknown as OidcClientsService,
      codes as never,
      {} as never,
      {} as never,
      tokens as unknown as TokenService,
      {} as never,
      {} as never,
      dataSource,
    );
    return {
      controller,
      events,
      manager,
      permissions,
      transactionState,
      codes,
      tokens,
    };
  }
});
