import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AccountServicePermissionEntity } from '../../database/entities/account-service-permission.entity';
import { AccountEntity } from '../../database/entities/account.entity';
import { AuditLogEntity } from '../../database/entities/audit-log.entity';
import {
  ServiceApplicationEntity,
  ServiceApplicationStatus,
} from '../../database/entities/service-application.entity';
import { ServicePermissionDefinitionEntity } from '../../database/entities/service-permission-definition.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { VISITOR_PERMISSION } from '../permissions/visitor-permission';
import { CreateServiceApplicationDto } from './dto/service-application.dto';

export interface ServiceAccessTokenClaims {
  sub?: string;
  'https://lafamila.xyz/claims/service'?: {
    key?: string;
    permission?: string;
    permissionSchemaVersion?: number;
  };
}

export interface ServiceApplicationStatusView {
  accountId: string;
  serviceKey: string;
  currentPermission: string | null;
  status: ServiceApplicationStatus | 'none';
  application: {
    id: string;
    status: ServiceApplicationStatus;
    message: string;
    createdAt: Date;
    reviewedAt: Date | null;
  } | null;
}

@Injectable()
export class ServiceApplicationsService {
  constructor(
    @InjectRepository(AccountEntity)
    private readonly accounts: Repository<AccountEntity>,
    @InjectRepository(ServiceEntity)
    private readonly services: Repository<ServiceEntity>,
    @InjectRepository(ServicePermissionDefinitionEntity)
    private readonly permissions: Repository<ServicePermissionDefinitionEntity>,
    @InjectRepository(AccountServicePermissionEntity)
    private readonly accountPermissions: Repository<AccountServicePermissionEntity>,
    @InjectRepository(ServiceApplicationEntity)
    private readonly applications: Repository<ServiceApplicationEntity>,
    private readonly dataSource: DataSource,
    private readonly auditLogs: AuditLogsService,
  ) {}

  list(status?: ServiceApplicationStatus): Promise<ServiceApplicationEntity[]> {
    return this.applications.find({
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
    });
  }

  async statusForServiceAccount(
    serviceKey: string,
    accountId: string,
  ): Promise<ServiceApplicationStatusView> {
    const service = await this.services.findOneBy({ serviceKey, status: 'active' });
    if (!service) {
      throw new NotFoundException('Service not found');
    }
    const [currentPermission, latestApplication] = await Promise.all([
      this.accountPermissions.findOne({
        where: { accountId, serviceId: service.id, status: 'active' },
        relations: { permissionDefinition: true },
      }),
      this.applications.findOne({
        where: { accountId, serviceId: service.id },
        order: { createdAt: 'DESC' },
      }),
    ]);
    const currentPermissionKey = currentPermission?.permissionDefinition.key ?? null;
    const status =
      currentPermissionKey && currentPermissionKey !== VISITOR_PERMISSION.key
        ? 'approved'
        : latestApplication?.status ?? 'none';
    return {
      accountId,
      serviceKey,
      currentPermission: currentPermissionKey,
      status,
      application: latestApplication
        ? {
            id: latestApplication.id,
            status: latestApplication.status,
            message: latestApplication.message,
            createdAt: latestApplication.createdAt,
            reviewedAt: latestApplication.reviewedAt,
          }
        : null,
    };
  }

  async createFromVisitorToken(
    claims: ServiceAccessTokenClaims,
    input: CreateServiceApplicationDto,
  ): Promise<ServiceApplicationEntity> {
    const accountId = claims.sub;
    const serviceClaim = claims['https://lafamila.xyz/claims/service'];
    if (!accountId || !serviceClaim?.key || !serviceClaim.permission) {
      throw new UnauthorizedException('Service access token is required');
    }
    if (serviceClaim.key !== input.serviceKey) {
      throw new ForbiddenException('Token service claim does not match request');
    }
    if (serviceClaim.permission !== VISITOR_PERMISSION.key) {
      throw new ForbiddenException('Only visitor accounts can apply for service access');
    }

    const [account, service] = await Promise.all([
      this.accounts.findOneBy({ id: accountId, status: 'active' }),
      this.services.findOneBy({ serviceKey: input.serviceKey, status: 'active' }),
    ]);
    if (!account || !service) {
      throw new NotFoundException('Account or service not found');
    }

    const currentPermission = await this.accountPermissions.findOne({
      where: { accountId: account.id, serviceId: service.id, status: 'active' },
      relations: { permissionDefinition: true },
    });
    if (currentPermission?.permissionDefinition.key !== VISITOR_PERMISSION.key) {
      throw new ForbiddenException('Current service permission is not visitor');
    }

    const existing = await this.applications.findOneBy({
      accountId: account.id,
      serviceId: service.id,
      status: 'pending',
    });
    if (existing) {
      existing.message = input.message ?? existing.message;
      return this.applications.save(existing);
    }

    const application = await this.applications.save(
      this.applications.create({
        account,
        accountId: account.id,
        service,
        serviceId: service.id,
        message: input.message ?? '',
        status: 'pending',
      }),
    );
    await this.auditLogs.record({
      actorAccountId: account.id,
      action: 'service_application.create',
      targetType: 'service_application',
      targetId: application.id,
      afterJson: {
        serviceId: service.id,
        message: application.message,
      },
    });
    return application;
  }

  async approve(
    applicationId: string,
    targetPermissionDefinitionId: string,
    reviewerAccountId?: string | null,
  ): Promise<ServiceApplicationEntity> {
    return this.dataSource.transaction(async (manager) => {
      const application = await manager.findOne(ServiceApplicationEntity, {
        where: { id: applicationId },
        relations: { account: true, service: true },
      });
      if (!application) {
        throw new NotFoundException('Service application not found');
      }
      if (application.status !== 'pending') {
        throw new BadRequestException('Only pending applications can be approved');
      }
      const targetPermission = await manager.findOne(
        ServicePermissionDefinitionEntity,
        {
          where: {
            id: targetPermissionDefinitionId,
            serviceId: application.serviceId,
            status: 'active',
          },
        },
      );
      if (!targetPermission) {
        throw new BadRequestException('Target permission must be active and belong to service');
      }
      if (targetPermission.key === VISITOR_PERMISSION.key) {
        throw new BadRequestException('Application must be approved to a non-visitor permission');
      }

      const existingPermission = await manager.findOne(
        AccountServicePermissionEntity,
        {
          where: {
            accountId: application.accountId,
            serviceId: application.serviceId,
          },
        },
      );
      await manager.save(
        AccountServicePermissionEntity,
        manager.create(AccountServicePermissionEntity, {
          id: existingPermission?.id,
          accountId: application.accountId,
          serviceId: application.serviceId,
          permissionDefinitionId: targetPermission.id,
          status: 'active',
          grantedByAccountId: reviewerAccountId ?? null,
          grantedAt: existingPermission?.grantedAt ?? new Date(),
          revokedAt: null,
        }),
      );

      application.status = 'approved';
      application.targetPermissionDefinition = targetPermission;
      application.targetPermissionDefinitionId = targetPermission.id;
      application.reviewedByAccountId = reviewerAccountId ?? null;
      application.reviewedAt = new Date();
      const saved = await manager.save(application);
      await manager.save(
        manager.create(AuditLogEntity, {
          actorAccountId: reviewerAccountId ?? null,
          action: 'service_application.approve',
          targetType: 'service_application',
          targetId: saved.id,
          afterJson: {
            accountId: saved.accountId,
            serviceId: saved.serviceId,
            targetPermissionDefinitionId: targetPermission.id,
          },
        }),
      );
      return saved;
    });
  }

  async reject(
    applicationId: string,
    reviewerAccountId?: string | null,
  ): Promise<ServiceApplicationEntity> {
    const application = await this.applications.findOneBy({ id: applicationId });
    if (!application) {
      throw new NotFoundException('Service application not found');
    }
    if (application.status !== 'pending') {
      throw new BadRequestException('Only pending applications can be rejected');
    }
    application.status = 'rejected';
    application.reviewedByAccountId = reviewerAccountId ?? null;
    application.reviewedAt = new Date();
    const saved = await this.applications.save(application);
    await this.auditLogs.record({
      actorAccountId: reviewerAccountId ?? null,
      action: 'service_application.reject',
      targetType: 'service_application',
      targetId: saved.id,
    });
    return saved;
  }
}
