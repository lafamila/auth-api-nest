import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { OidcClientEntity } from '../../database/entities/oidc-client.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ServiceRegistryService } from '../service-registry/service-registry.service';
import { OidcClientsService } from './oidc-clients.service';

describe('OidcClientsService public client security', () => {
  const serviceEntity = {
    id: 'service-id',
    serviceKey: 'notification',
    status: 'active',
  };
  const save = jest.fn(async (value: OidcClientEntity) => value);
  const create = jest.fn((value: unknown) => value);
  const clients = {
    existsBy: jest.fn(async () => false),
    create,
    save,
    findOne: jest.fn(),
  } as unknown as Repository<OidcClientEntity>;
  const services = {
    findById: jest.fn(async () => serviceEntity),
  } as unknown as ServiceRegistryService;
  const password = {
    hash: jest.fn(async () => 'hash'),
  } as unknown as PasswordService;
  const audit = {
    record: jest.fn(async () => undefined),
  } as unknown as AuditLogsService;
  let service: OidcClientsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OidcClientsService(clients, services, password, audit);
  });

  it('rejects creating a public client with PKCE disabled', async () => {
    await expect(
      service.create('service-id', {
        clientId: 'notification-app',
        clientType: 'public',
        redirectUris: ['xyz.lafamila.not:/oauth/callback'],
        requirePkce: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('defaults public clients to PKCE enabled', async () => {
    await service.create('service-id', {
      clientId: 'notification-app',
      clientType: 'public',
      redirectUris: ['xyz.lafamila.not:/oauth/callback'],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ clientType: 'public', requirePkce: true }),
    );
  });

  it('rejects updates that disable PKCE on a public client', async () => {
    const current = {
      id: 'client-row-id',
      serviceId: 'service-id',
      clientId: 'notification-app',
      clientType: 'public',
      clientSecretHash: null,
      requirePkce: true,
    } as OidcClientEntity;
    (clients.findOne as jest.Mock).mockResolvedValue(current);

    await expect(
      service.update('service-id', current.id, { requirePkce: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });
});
