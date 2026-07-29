import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { AccountServicePermissionEntity } from '../../database/entities/account-service-permission.entity';
import { AccountEntity } from '../../database/entities/account.entity';
import { ServiceApplicationEntity } from '../../database/entities/service-application.entity';
import { ServicePermissionDefinitionEntity } from '../../database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ServiceApplicationsService } from './service-applications.service';

describe('ServiceApplicationsService', () => {
  const account = { id: 'account-1', status: 'active' } as AccountEntity;
  const service = {
    id: 'service-1',
    serviceKey: 'travel',
    status: 'active',
  } as ServiceEntity;
  const permission = (
    key: string,
    sortOrder: number,
    status: ServicePermissionDefinitionEntity['status'] = 'active',
  ) =>
    ({
      id: `permission-${key}`,
      serviceId: service.id,
      key,
      label: key,
      sortOrder,
      status,
      createdAt: new Date(1_700_000_000_000 + sortOrder),
    }) as ServicePermissionDefinitionEntity;
  const superadmin = permission('superadmin', -2000);
  const visitor = permission('visitor', -1000);
  const user = permission('user', 0);
  const admin = permission('admin', 1);

  function setup(
    current = user,
    existingApplication?: ServiceApplicationEntity,
  ) {
    const permissionsByKey = new Map(
      [superadmin, visitor, user, admin].map((definition) => [
        definition.key,
        definition,
      ]),
    );
    const accounts = {
      findOneBy: jest.fn().mockResolvedValue(account),
    } as unknown as Repository<AccountEntity>;
    const services = {
      findOneBy: jest.fn().mockResolvedValue(service),
    } as unknown as Repository<ServiceEntity>;
    const permissions = {
      findOneBy: jest.fn().mockImplementation(({ key, status }) => {
        const definition = permissionsByKey.get(key);
        return Promise.resolve(
          definition?.status === status ? definition : null,
        );
      }),
      find: jest.fn().mockResolvedValue([superadmin, visitor, user, admin]),
    } as unknown as Repository<ServicePermissionDefinitionEntity>;
    const accountPermissions = {
      findOne: jest.fn().mockResolvedValue({
        accountId: account.id,
        serviceId: service.id,
        status: 'active',
        permissionDefinition: current,
      }),
    } as unknown as Repository<AccountServicePermissionEntity>;
    const createApplication = jest.fn(
      (value: Partial<ServiceApplicationEntity>) =>
        value as ServiceApplicationEntity,
    );
    const saveApplication = jest.fn(
      (
        value: Partial<ServiceApplicationEntity>,
      ): Promise<ServiceApplicationEntity> =>
        Promise.resolve({
          ...value,
          id: value.id ?? existingApplication?.id ?? 'application-1',
        } as ServiceApplicationEntity),
    );
    const applications = {
      findOneBy: jest.fn().mockResolvedValue(existingApplication ?? null),
      findOne: jest.fn().mockResolvedValue(existingApplication ?? null),
      create: createApplication,
      save: saveApplication,
    } as unknown as Repository<ServiceApplicationEntity>;
    const auditLogs = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditLogsService;
    return {
      applications,
      createApplication,
      service: new ServiceApplicationsService(
        accounts,
        services,
        permissions,
        accountPermissions,
        applications,
        {} as DataSource,
        auditLogs,
      ),
    };
  }

  const claims = (
    currentPermission: string,
    serviceKey = service.serviceKey,
  ) => ({
    sub: account.id,
    'https://lafamila.xyz/claims/service': {
      key: serviceKey,
      permission: currentPermission,
    },
  });

  it('updates the existing pending application for a strictly higher permission', async () => {
    const existing = {
      id: 'pending-1',
      accountId: account.id,
      serviceId: service.id,
      status: 'pending',
      message: 'Old message',
      targetPermissionDefinition: user,
      targetPermissionDefinitionId: user.id,
    } as ServiceApplicationEntity;
    const { service: applications, createApplication } = setup(user, existing);

    await expect(
      applications.createFromAccessToken(claims('user'), {
        serviceKey: service.serviceKey,
        requestedPermissionKey: 'admin',
        message: 'Updated message',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: existing.id,
        message: 'Updated message',
        targetPermissionDefinitionId: admin.id,
      }),
    );
    expect(createApplication).not.toHaveBeenCalled();
  });

  it('reports a pending upgrade instead of treating any non-visitor as approved', async () => {
    const pendingUpgrade = {
      id: 'pending-upgrade',
      accountId: account.id,
      serviceId: service.id,
      status: 'pending',
      message: '',
      targetPermissionDefinition: admin,
      targetPermissionDefinitionId: admin.id,
      createdAt: new Date(),
      reviewedAt: null,
    } as ServiceApplicationEntity;
    const { service: applications } = setup(user, pendingUpgrade);

    await expect(
      applications.statusForServiceAccount(service.serviceKey, account.id),
    ).resolves.toEqual(expect.objectContaining({ status: 'pending' }));
  });

  it.each(['user', 'visitor'])(
    'rejects a user request for same or lower permission %s',
    async (requestedPermissionKey) => {
      const { service: applications } = setup(user);

      await expect(
        applications.createFromAccessToken(claims('user'), {
          serviceKey: service.serviceKey,
          requestedPermissionKey,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each(['missing', 'superadmin'])(
    'rejects non-requestable permission %s',
    async (requestedPermissionKey) => {
      const { service: applications } = setup(user);

      await expect(
        applications.createFromAccessToken(claims('user'), {
          serviceKey: service.serviceKey,
          requestedPermissionKey,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('rejects an inactive target permission', async () => {
    admin.status = 'deprecated';
    const { service: applications } = setup(user);

    await expect(
      applications.createFromAccessToken(claims('user'), {
        serviceKey: service.serviceKey,
        requestedPermissionKey: 'admin',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    admin.status = 'active';
  });

  it('preserves target-less visitor onboarding', async () => {
    const { service: applications } = setup(visitor);

    await expect(
      applications.createFromAccessToken(claims('visitor'), {
        serviceKey: service.serviceKey,
        message: 'Please grant access',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'pending',
        targetPermissionDefinitionId: null,
      }),
    );
  });

  it('rejects cross-service and stale permission claims', async () => {
    const { service: applications } = setup(user);

    await expect(
      applications.createFromAccessToken(claims('user', 'other-service'), {
        serviceKey: service.serviceKey,
        requestedPermissionKey: 'admin',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      applications.createFromAccessToken(claims('visitor'), {
        serviceKey: service.serviceKey,
        requestedPermissionKey: 'admin',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
