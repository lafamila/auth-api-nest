import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { hashSecret } from '../../common/crypto/secret-hash';
import { OidcClientEntity } from '../../database/entities/oidc-client.entity';
import { ServiceOnboardingRequestEntity } from '../../database/entities/service-onboarding-request.entity';
import { ServicePermissionDefinitionEntity } from '../../database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { NotificationActionTargetsService } from '../../notifications/notification-action-targets.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { OidcClientsService } from '../oidc-clients/oidc-clients.service';
import { PermissionWebhooksService } from '../permission-webhooks/permission-webhooks.service';
import { PermissionsService } from '../permissions/permissions.service';
import { ServiceCredentialsService } from '../service-credentials/service-credentials.service';
import {
  CreateServiceDto,
  UpdateServiceDto,
} from '../service-registry/dto/service.dto';
import { ServiceRegistryService } from '../service-registry/service-registry.service';
import { CreateServiceOnboardingRequestDto } from './dto/service-onboarding.dto';
import { ServiceOnboardingService } from './service-onboarding.service';

describe('Service onboarding category preservation', () => {
  const spec: CreateServiceOnboardingRequestDto = {
    serviceKey: 'game-platform',
    name: 'Game platform',
    permissions: [],
  };

  function setup(existing = true) {
    let current: ServiceEntity | null = existing
      ? Object.assign(new ServiceEntity(), {
          id: 'service-id',
          serviceKey: spec.serviceKey,
          name: spec.name,
          category: 'productivity',
        })
      : null;
    const prior: ServiceOnboardingRequestEntity = Object.assign(
      new ServiceOnboardingRequestEntity(),
      {
        id: 'prior-id',
        serviceKey: spec.serviceKey,
        revision: 1,
        status: 'approved',
        requestSecretHash: hashSecret('request-secret'),
        requestedSpecJson: { ...spec, category: 'productivity' },
      },
    );
    const stored = new Map<string, ServiceOnboardingRequestEntity>([
      [prior.id, prior],
    ]);
    const requests = {
      findOneBy: jest.fn(async (criteria: { id?: string }) =>
        criteria.id ? (stored.get(criteria.id) ?? null) : null,
      ),
      create: jest.fn((input: object) =>
        Object.assign(
          new ServiceOnboardingRequestEntity(),
          { id: 'pending-id' },
          input,
        ),
      ),
      save: jest.fn(async (row: ServiceOnboardingRequestEntity) => {
        stored.set(row.id, row);
        return row;
      }),
    };
    const registry = {
      findByKey: jest.fn(async () => current),
      create: jest.fn(async (input: CreateServiceDto) => {
        current = Object.assign(new ServiceEntity(), {
          id: 'service-id',
          ...input,
          category: input.category ?? 'other',
        });
        return current;
      }),
      update: jest.fn(async (_id: string, input: UpdateServiceDto) => {
        Object.assign(current!, input);
        return current;
      }),
    };
    const hooks = {
      validateRequestedSpec: jest.fn(),
      configureFromApprovedOnboarding: jest.fn(),
    };
    const service = new ServiceOnboardingService(
      requests as unknown as Repository<ServiceOnboardingRequestEntity>,
      {} as Repository<ServicePermissionDefinitionEntity>,
      {} as Repository<OidcClientEntity>,
      registry as unknown as ServiceRegistryService,
      {} as PermissionsService,
      {} as OidcClientsService,
      {} as ServiceCredentialsService,
      {} as PasswordService,
      { record: jest.fn() } as unknown as AuditLogsService,
      hooks as unknown as PermissionWebhooksService,
      hooks as unknown as NotificationActionTargetsService,
    );
    return {
      service,
      requests,
      registry,
      prior,
      stored,
      current: () => current,
    };
  }

  it('preserves the current admin category at approval instead of an older request snapshot', async () => {
    const ctx = setup();
    await ctx.service.update(ctx.prior.id, spec, null, 'request-secret');
    expect(ctx.stored.get('pending-id')!.requestedSpecJson).not.toHaveProperty(
      'category',
    );
    ctx.current()!.category = 'game';
    const result = await ctx.service.approve('pending-id', 'admin-id');
    expect(ctx.registry.update).toHaveBeenCalledWith('service-id', {
      name: spec.name,
      description: '',
      status: 'active',
    });
    expect(ctx.current()!.category).toBe('game');
    expect(result.request.approvedSnapshot).toMatchObject({ category: 'game' });
  });

  it('applies an explicitly submitted category on an approved update', async () => {
    const ctx = setup();
    await ctx.service.update(
      ctx.prior.id,
      { ...spec, category: 'education' },
      null,
      'request-secret',
    );
    expect(ctx.stored.get('pending-id')!.requestedSpecJson).toMatchObject({
      category: 'education',
    });
    await ctx.service.approve('pending-id', 'admin-id');
    expect(ctx.current()!.category).toBe('education');
  });

  it.each([undefined, 'game'] as const)(
    'supports new requests with category %s without guessing by service name',
    async (category) => {
      const ctx = setup(false);
      await ctx.service.create({ ...spec, category }, null);
      await ctx.service.approve('pending-id', 'admin-id');
      expect(ctx.current()!.category).toBe(category ?? 'other');
    },
  );

  it.each([null, '', 'unknown'])(
    'rejects explicit invalid category %j on submission and stored approval',
    async (category) => {
      const ctx = setup();
      const invalid = { ...spec, category } as never;
      await expect(ctx.service.create(invalid, null)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        ctx.service.update(ctx.prior.id, invalid, null, 'request-secret'),
      ).rejects.toBeInstanceOf(BadRequestException);
      ctx.prior.status = 'pending';
      ctx.prior.requestedSpecJson = { ...spec, category };
      await expect(
        ctx.service.approve(ctx.prior.id, 'admin-id'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.registry.update).not.toHaveBeenCalled();
      expect(ctx.registry.create).not.toHaveBeenCalled();
    },
  );
});
