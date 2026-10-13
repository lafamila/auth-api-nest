import { Repository } from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { ServiceCredentialEntity } from '../../database/entities/service-credential.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ServiceRegistryService } from '../service-registry/service-registry.service';
import { AuthenticatedServiceCredential } from './service-credential-request';
import { ServiceCredentialsService } from './service-credentials.service';

describe('ServiceCredentialsService.verifyPresented', () => {
  const service = {
    id: 'service-1',
    serviceKey: 'todo',
    status: 'active',
  } as ServiceEntity;

  const caller: AuthenticatedServiceCredential = {
    credentialId: 'credential-caller',
    keyId: 'asc_todo_caller',
    serviceId: service.id,
    serviceKey: service.serviceKey,
    scopes: ['sync'],
  };

  function target(
    overrides: Partial<ServiceCredentialEntity> = {},
  ): ServiceCredentialEntity {
    return {
      id: 'credential-laptop',
      service,
      serviceId: service.id,
      keyId: 'asc_todo_laptop',
      secretHash: 'hashed-laptop-secret',
      name: 'laptop sync',
      description: '',
      scopes: ['sync'],
      status: 'active',
      expiresAt: null,
      lastUsedAt: null,
      lastUsedFrom: null,
      rotatedAt: null,
      disabledAt: null,
      ...overrides,
    } as ServiceCredentialEntity;
  }

  function setup(options?: {
    credential?: ServiceCredentialEntity | null;
    secretMatches?: boolean;
  }) {
    const credential =
      options?.credential === undefined ? target() : options.credential;
    const update = jest.fn().mockResolvedValue(undefined);
    const credentials = {
      findOne: jest.fn().mockResolvedValue(credential),
      update,
    } as unknown as Repository<ServiceCredentialEntity>;
    const verify = jest.fn().mockResolvedValue(options?.secretMatches ?? true);
    const record = jest.fn().mockResolvedValue(undefined);
    return {
      update,
      verify,
      record,
      service: new ServiceCredentialsService(
        credentials,
        {} as ServiceRegistryService,
        { verify } as unknown as PasswordService,
        { record } as unknown as AuditLogsService,
      ),
    };
  }

  it('accepts an active credential that holds the required scope', async () => {
    const { service: credentials, verify, update, record } = setup();

    await expect(
      credentials.verifyPresented('asc_todo_laptop', 'laptop-secret', {
        caller,
        requiredScope: 'sync',
        ipAddress: '10.0.0.5',
      }),
    ).resolves.toEqual({
      valid: true,
      serviceKey: 'todo',
      scopes: ['sync'],
      status: 'active',
    });
    expect(verify).toHaveBeenCalledWith(
      'hashed-laptop-secret',
      'laptop-secret',
    );
    expect(update).toHaveBeenCalledWith(
      { id: 'credential-laptop' },
      expect.objectContaining({ lastUsedFrom: '10.0.0.5' }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'service_credential.verify',
        targetType: 'service_credential',
        targetId: 'credential-laptop',
        afterJson: expect.objectContaining({
          valid: true,
          reason: null,
          detail: 'ok',
          targetKeyId: 'asc_todo_laptop',
          requiredScope: 'sync',
          callerKeyId: 'asc_todo_caller',
        }),
      }),
    );
  });

  it('rejects a wrong secret as invalid_credential without marking the target used', async () => {
    const {
      service: credentials,
      update,
      record,
    } = setup({
      secretMatches: false,
    });

    await expect(
      credentials.verifyPresented('asc_todo_laptop', 'wrong-secret', {
        caller,
        requiredScope: 'sync',
      }),
    ).resolves.toEqual({ valid: false, reason: 'invalid_credential' });
    expect(update).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        afterJson: expect.objectContaining({
          valid: false,
          reason: 'invalid_credential',
          detail: 'secret_mismatch',
        }),
      }),
    );
  });

  it('rejects a disabled credential as disabled', async () => {
    const { service: credentials, record } = setup({
      credential: target({ status: 'disabled', disabledAt: new Date() }),
    });

    await expect(
      credentials.verifyPresented('asc_todo_laptop', 'laptop-secret', {
        caller,
        requiredScope: 'sync',
      }),
    ).resolves.toEqual({ valid: false, reason: 'disabled' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        afterJson: expect.objectContaining({
          reason: 'disabled',
          detail: 'status_disabled',
        }),
      }),
    );
  });

  it('rejects a credential missing the required scope as scope_missing', async () => {
    const { service: credentials, record } = setup({
      credential: target({ scopes: ['account.search'] }),
    });

    await expect(
      credentials.verifyPresented('asc_todo_laptop', 'laptop-secret', {
        caller,
        requiredScope: 'sync',
      }),
    ).resolves.toEqual({ valid: false, reason: 'scope_missing' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        afterJson: expect.objectContaining({
          reason: 'scope_missing',
          detail: 'scope_missing',
        }),
      }),
    );
  });

  it('skips the scope check when requiredScope is omitted', async () => {
    const { service: credentials, record } = setup({
      credential: target({ scopes: ['account.search'] }),
    });

    await expect(
      credentials.verifyPresented('asc_todo_laptop', 'laptop-secret', {
        caller,
      }),
    ).resolves.toEqual({
      valid: true,
      serviceKey: 'todo',
      scopes: ['account.search'],
      status: 'active',
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        afterJson: expect.objectContaining({
          detail: 'ok',
          requiredScope: null,
        }),
      }),
    );
  });

  it('hides an unknown keyId behind invalid_credential', async () => {
    const { service: credentials, record } = setup({ credential: null });

    await expect(
      credentials.verifyPresented('asc_todo_missing', 'laptop-secret', {
        caller,
        requiredScope: 'sync',
      }),
    ).resolves.toEqual({ valid: false, reason: 'invalid_credential' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: null,
        afterJson: expect.objectContaining({ detail: 'not_found' }),
      }),
    );
  });

  it('hides another service’s credential behind invalid_credential', async () => {
    const {
      service: credentials,
      update,
      record,
    } = setup({
      credential: target({
        service: { ...service, serviceKey: 'travel' },
      }),
    });

    await expect(
      credentials.verifyPresented('asc_travel_other', 'laptop-secret', {
        caller,
        requiredScope: 'sync',
      }),
    ).resolves.toEqual({ valid: false, reason: 'invalid_credential' });
    expect(update).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        afterJson: expect.objectContaining({ detail: 'cross_service' }),
      }),
    );
  });
});
