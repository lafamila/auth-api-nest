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

describe('OidcController refresh grant permissions', () => {
  const account = {
    id: 'account-1',
    status: 'active',
    passwordResetRequired: false,
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

  it('mints the refreshed access token from the current changed permission', async () => {
    const currentPermission = {
      permissionDefinition: {
        key: 'admin',
      } as ServicePermissionDefinitionEntity,
    } as AccountServicePermissionEntity;
    const { controller, tokens, permissions } = setup(currentPermission);

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
    );
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

  function setup(currentPermission: AccountServicePermissionEntity | null) {
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
      consumeRefreshToken: jest.fn().mockResolvedValue({
        accountId: account.id,
        clientId: client.clientId,
        familyId: 'refresh-family',
      }),
      issueTokens: jest
        .fn()
        .mockResolvedValue({ access_token: 'new-access-token' }),
    };
    const controller = new OidcController(
      {} as AppConfigService,
      permissions as unknown as AccountPermissionsService,
      accounts as unknown as AccountsService,
      clients as unknown as OidcClientsService,
      {} as never,
      {} as never,
      {} as never,
      tokens as unknown as TokenService,
      {} as never,
    );
    return { controller, permissions, tokens };
  }
});
