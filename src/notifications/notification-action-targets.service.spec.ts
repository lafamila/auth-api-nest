import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { NotificationActionTargetEntity } from '../database/entities/notification-action-target.entity';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';
import { NotificationActionTargetsService } from './notification-action-targets.service';

describe('NotificationActionTargetsService', () => {
  const findOneBy = jest.fn();
  const repository = {
    findOneBy,
    update: jest.fn(),
    findBy: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOneByOrFail: jest.fn(),
  } as unknown as Repository<NotificationActionTargetEntity>;
  const auditLogs = { record: jest.fn() } as unknown as AuditLogsService;
  let service: NotificationActionTargetsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new NotificationActionTargetsService(repository, auditLogs);
  });

  it('resolves only allowlisted HTTPS paths into a validated snapshot', async () => {
    findOneBy.mockResolvedValue({
      id: 'target-id',
      serviceId: 'service-id',
      targetKey: 'location-todo',
      baseUrl: 'https://loc.lafamila.xyz/',
      fallbackUrl: 'https://loc.lafamila.xyz/',
      allowedPaths: ['/notifications/**'],
      allowedCustomSchemes: [],
      status: 'active',
    });

    await expect(
      service.resolve('service-id', {
        targetKey: 'location-todo',
        path: '/notifications/018f',
      }),
    ).resolves.toEqual({
      targetKey: 'location-todo',
      path: '/notifications/018f',
      url: 'https://loc.lafamila.xyz/notifications/018f',
      fallbackUrl: 'https://loc.lafamila.xyz/notifications/018f',
      allowedCustomSchemes: [],
    });

    await expect(
      service.resolve('service-id', {
        targetKey: 'location-todo',
        path: '/admin',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects unsafe onboarding targets and action paths', async () => {
    expect(() =>
      service.validateRequestedSpec([
        {
          targetKey: 'unsafe',
          baseUrl: 'http://example.test',
          allowedPaths: ['/notifications/**'],
        },
      ]),
    ).toThrow(BadRequestException);

    expect(() =>
      service.validateRequestedSpec([
        {
          targetKey: 'unsafe',
          baseUrl: 'https://example.test/app/',
          allowedPaths: ['/notifications/**'],
        },
      ]),
    ).toThrow(BadRequestException);

    findOneBy.mockResolvedValue({
      targetKey: 'location-todo',
      baseUrl: 'https://loc.lafamila.xyz/',
      fallbackUrl: null,
      allowedPaths: ['/notifications/**'],
      allowedCustomSchemes: [],
      status: 'active',
    });

    await expect(
      service.resolve('service-id', {
        targetKey: 'location-todo',
        path: '/notifications/%2e%2e/admin',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    '/notifications/%252e%252e/admin',
    '/notifications/%74arget',
    '/notifications/%2Fadmin',
    '/notifications//admin',
    '/notifications/%5cadmin',
  ])('rejects recursively encoded or non-canonical path %s', async (path) => {
    findOneBy.mockResolvedValue({
      targetKey: 'location-todo',
      baseUrl: 'https://loc.lafamila.xyz/',
      fallbackUrl: null,
      allowedPaths: ['/notifications/**'],
      allowedCustomSchemes: [],
      status: 'active',
    });

    await expect(
      service.resolve('service-id', {
        targetKey: 'location-todo',
        path,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
