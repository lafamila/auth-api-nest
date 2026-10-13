import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { OidcClientEntity } from '../../database/entities/oidc-client.entity';
import { ServiceOnboardingRequestEntity } from '../../database/entities/service-onboarding-request.entity';
import { ServicePermissionDefinitionEntity } from '../../database/entities/service-permission-definition.entity';
import { NotificationActionTargetsService } from '../../notifications/notification-action-targets.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { OidcClientsService } from '../oidc-clients/oidc-clients.service';
import { PermissionWebhooksService } from '../permission-webhooks/permission-webhooks.service';
import { PermissionsService } from '../permissions/permissions.service';
import { ServiceCredentialsService } from '../service-credentials/service-credentials.service';
import { ServiceRegistryService } from '../service-registry/service-registry.service';
import { CreateServiceOnboardingRequestDto } from './dto/service-onboarding.dto';
import { ServiceOnboardingService } from './service-onboarding.service';

describe('ServiceOnboardingService OIDC security', () => {
  const insecureSpec: CreateServiceOnboardingRequestDto = {
    serviceKey: 'notification',
    name: 'Noti',
    permissions: [],
    oidcClients: [
      {
        clientId: 'notification-app',
        clientType: 'public',
        redirectUris: ['xyz.lafamila.noti:/oauth/callback'],
        requirePkce: false,
      },
    ],
  };

  it('rejects insecure public clients on create and update submission', async () => {
    const service = createService({});

    await expect(service.create(insecureSpec, null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.update('request-id', { ...insecureSpec }, null, 'request-secret'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects approval of a previously stored insecure public client', async () => {
    const request = {
      id: 'request-id',
      status: 'pending',
      requestedSpecJson: insecureSpec,
    } as unknown as ServiceOnboardingRequestEntity;
    const service = createService({ findOneBy: jest.fn(async () => request) });

    await expect(
      service.approve(request.id, 'admin-id'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  function createService(requests: object): ServiceOnboardingService {
    return new ServiceOnboardingService(
      requests as Repository<ServiceOnboardingRequestEntity>,
      {} as Repository<ServicePermissionDefinitionEntity>,
      {} as Repository<OidcClientEntity>,
      {} as ServiceRegistryService,
      {} as PermissionsService,
      {} as OidcClientsService,
      {} as ServiceCredentialsService,
      {} as PasswordService,
      {} as AuditLogsService,
      {} as PermissionWebhooksService,
      {} as NotificationActionTargetsService,
    );
  }
});
