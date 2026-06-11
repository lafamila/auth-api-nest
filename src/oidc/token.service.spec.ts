import { TokenService } from './token.service';
import { SigningKeyService } from './signing-key.service';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { OidcClientEntity } from '../database/entities/oidc-client.entity';
import { ServiceEntity } from '../database/entities/service.entity';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { ServicePermissionDefinitionEntity } from '../database/entities/service-permission-definition.entity';

const config = {
  issuerUrl: 'http://localhost:3032',
} as AppConfigService;

describe('TokenService', () => {
  it('issues and rotates refresh tokens by family', () => {
    const service = new TokenService(config, new SigningKeyService());
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
      permissionDefinition: { key: 'admin' } as ServicePermissionDefinitionEntity,
    } as AccountServicePermissionEntity;

    const first = service.issueTokens(account, client, permission);
    const consumed = service.consumeRefreshToken(first.refresh_token);
    const second = service.issueTokens(account, client, permission, consumed.familyId);

    expect(first.access_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(() => service.consumeRefreshToken(first.refresh_token)).toThrow(
      'Refresh token reuse detected',
    );
  });

  it('issues body-lab access tokens with the service audience and owner claim', () => {
    const service = new TokenService(config, new SigningKeyService());
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
      permissionDefinition: { key: 'owner' } as ServicePermissionDefinitionEntity,
    } as AccountServicePermissionEntity;

    const tokens = service.issueTokens(account, client, permission);
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
