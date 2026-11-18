import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { ServiceEntity } from '../../database/entities/service.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ServiceRegistryService } from './service-registry.service';

describe('ServiceRegistryService categories', () => {
  function setup() {
    const current = {
      id: 'service-id',
      serviceKey: 'game-platform',
      name: 'Game platform',
      category: 'other',
      permissionSchemaVersion: 1,
    } as ServiceEntity;
    const manager = {
      create: jest.fn((_entity: unknown, input: object) => input),
      save: jest.fn(async (input: unknown) => input),
      findOne: jest.fn(async () => ({ ...current })),
      findOneByOrFail: jest.fn(async () => ({ ...current })),
      update: jest.fn(async (_entity: unknown, _id: string, input: object) => {
        Object.assign(current, input);
      }),
    };
    const repository = {
      existsBy: jest.fn(async () => false),
      findOneBy: jest.fn(async () => ({ ...current })),
      update: jest.fn(async (_id: string, input: object) => {
        // An admin edit can occur after the onboarding update read.
        current.category = 'game';
        Object.assign(current, input);
      }),
    };
    const transaction = jest.fn(
      async (callback: (value: typeof manager) => Promise<unknown>) =>
        callback(manager),
    );
    const audit = { record: jest.fn(async () => ({})) };
    const service = new ServiceRegistryService(
      repository as unknown as Repository<ServiceEntity>,
      { transaction } as unknown as DataSource,
      audit as unknown as AuditLogsService,
    );
    return { service, current, manager, repository, transaction, audit };
  }

  it.each([undefined, 'game'] as const)(
    'creates a service with category %s or the other default',
    async (category) => {
      const { service, manager } = setup();
      await service.create({
        serviceKey: 'game-platform',
        name: 'Game',
        category,
      });
      expect(manager.create).toHaveBeenCalledWith(
        ServiceEntity,
        expect.objectContaining({ category: category ?? 'other' }),
      );
    },
  );

  it('preserves an admin category change when an update omits category, including a concurrent change', async () => {
    const { service, current, repository } = setup();
    const saved = await service.update(current.id, { name: 'Updated name' });
    expect(repository.update).toHaveBeenCalledWith(current.id, {
      name: 'Updated name',
    });
    expect(saved.category).toBe('game');
  });

  it('keeps empty internal updates as no-ops without requiring a database update set', async () => {
    const { service, repository } = setup();
    expect((await service.update('service-id', {})).category).toBe('other');
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('saves only category and records actor and before/after in the same transaction', async () => {
    const { service, current, manager, audit } = setup();
    const actor = {
      actorAccountId: 'admin-id',
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    };
    const saved = await service.updateCategory(current.id, 'game', actor);
    expect(manager.findOne).toHaveBeenCalledWith(ServiceEntity, {
      where: { id: current.id },
      lock: { mode: 'pessimistic_write' },
    });
    expect(manager.update).toHaveBeenCalledWith(ServiceEntity, current.id, {
      category: 'game',
    });
    expect(audit.record).toHaveBeenCalledWith(
      {
        ...actor,
        action: 'service.category.update',
        targetType: 'service',
        targetId: current.id,
        beforeJson: { category: 'other' },
        afterJson: { category: 'game' },
      },
      manager,
    );
    expect(saved).toMatchObject({
      name: 'Game platform',
      category: 'game',
      permissionSchemaVersion: 1,
    });
  });

  it('propagates audit failure so the database transaction cannot commit without its audit', async () => {
    const { service, audit } = setup();
    audit.record.mockRejectedValueOnce(new Error('Audit unavailable'));
    await expect(
      service.updateCategory('service-id', 'game', {}),
    ).rejects.toThrow('Audit unavailable');
  });

  it('rejects unknown service IDs without writing category or audit', async () => {
    const { service, manager, audit } = setup();
    manager.findOne.mockResolvedValueOnce(null as unknown as ServiceEntity);
    await expect(
      service.updateCategory('missing-id', 'game', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([null, '', 'unknown'])(
    'rejects invalid categories %j before any database writes',
    async (category) => {
      const { service, repository, transaction } = setup();
      await expect(
        service.create({ serviceKey: 'test', name: 'Test', category } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update('service-id', { category } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.updateCategory('service-id', category as never, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.update).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
