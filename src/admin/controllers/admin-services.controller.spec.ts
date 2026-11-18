import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { ServiceRegistryService } from '../../domain/service-registry/service-registry.service';
import { AdminGuard } from '../admin.guard';
import { AdminServicesController } from './admin-services.controller';

describe('AdminServicesController category-only operational edit', () => {
  const updateCategory = jest.fn();
  const services = { updateCategory } as unknown as ServiceRegistryService;
  const controller = new AdminServicesController(services);
  const request = {
    adminAccount: { id: 'superadmin-id' },
    ip: '127.0.0.1',
    header: jest.fn(() => 'category-test-agent'),
  } as unknown as Request & { adminAccount: { id: string } };

  beforeEach(() => jest.clearAllMocks());

  it('keeps the superadmin session guard and only passes category plus audit context', () => {
    expect(
      Reflect.getMetadata('__guards__', AdminServicesController),
    ).toContain(AdminGuard);
    void controller.updateCategory('service-id', { category: 'game' }, request);
    expect(updateCategory).toHaveBeenCalledWith('service-id', 'game', {
      actorAccountId: 'superadmin-id',
      ipAddress: '127.0.0.1',
      userAgent: 'category-test-agent',
    });
  });

  it.each([
    'name',
    'description',
    'serviceKey',
    'oidcClients',
    'allowedScopes',
    'status',
    'permissionSchemaVersion',
    'category ',
  ])('forbids direct edits to %s even with a valid category', (field) => {
    for (const body of [
      { [field]: 'changed' },
      { category: 'game', [field]: 'changed' },
    ]) {
      expect(() =>
        controller.updateCategory('service-id', body, request),
      ).toThrow(ForbiddenException);
    }
    expect(updateCategory).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { category: null },
    { category: 'unknown' },
    { category: '' },
    [],
  ])('rejects a missing or invalid category %j', (body) => {
    expect(() =>
      controller.updateCategory(
        'service-id',
        body as Record<string, unknown>,
        request,
      ),
    ).toThrow(BadRequestException);
    expect(updateCategory).not.toHaveBeenCalled();
  });
});
