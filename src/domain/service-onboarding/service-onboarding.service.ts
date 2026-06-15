import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { MoreThan, Repository } from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { hashSecret, verifySecretHash } from '../../common/crypto/secret-hash';
import { OidcClientEntity } from '../../database/entities/oidc-client.entity';
import { ServicePermissionDefinitionEntity } from '../../database/entities/service-permission-definition.entity';
import { ServiceOnboardingRequestEntity } from '../../database/entities/service-onboarding-request.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { OidcClientsService } from '../oidc-clients/oidc-clients.service';
import { PermissionsService } from '../permissions/permissions.service';
import { ServiceCredentialsService } from '../service-credentials/service-credentials.service';
import { ServiceRegistryService } from '../service-registry/service-registry.service';
import {
  CreateServiceOnboardingRequestDto,
  RejectServiceOnboardingRequestDto,
  UpdateServiceOnboardingRequestDto,
} from './dto/service-onboarding.dto';

const PUBLIC_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const PUBLIC_REQUEST_IP_LIMIT = 10;

@Injectable()
export class ServiceOnboardingService {
  constructor(
    @InjectRepository(ServiceOnboardingRequestEntity)
    private readonly requests: Repository<ServiceOnboardingRequestEntity>,
    @InjectRepository(ServicePermissionDefinitionEntity)
    private readonly permissions: Repository<ServicePermissionDefinitionEntity>,
    @InjectRepository(OidcClientEntity)
    private readonly clients: Repository<OidcClientEntity>,
    private readonly serviceRegistry: ServiceRegistryService,
    private readonly permissionsService: PermissionsService,
    private readonly clientsService: OidcClientsService,
    private readonly credentialsService: ServiceCredentialsService,
    private readonly passwordService: PasswordService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async create(input: CreateServiceOnboardingRequestDto, requestIp: string | null) {
    await this.assertPublicRateLimit(requestIp);
    await this.assertNoPendingForService(input.serviceKey);
    if (await this.serviceRegistry.findByKey(input.serviceKey)) {
      throw new ConflictException('Service key already exists; submit an update request');
    }
    const requestSecret = this.generateSecret();
    const saved = await this.requests.save(
      this.requests.create({
        serviceKey: input.serviceKey,
        kind: 'create',
        status: 'pending',
        revision: 1,
        requestSecretHash: hashSecret(requestSecret),
        requesterName: input.requesterName ?? null,
        requesterEmail: input.requesterEmail ?? null,
        requestedSpecJson: this.spec(input),
        requestIp,
      }),
    );
    return {
      request: this.safeRequest(saved),
      requestSecret,
    };
  }

  async update(
    requestId: string,
    input: UpdateServiceOnboardingRequestDto,
    requestIp: string | null,
    headerSecret?: string,
  ) {
    await this.assertPublicRateLimit(requestIp);
    const prior = await this.findById(requestId);
    const requestSecret = headerSecret || input.requestSecret;
    if (!requestSecret || !verifySecretHash(prior.requestSecretHash, requestSecret)) {
      throw new ForbiddenException('Valid request secret is required');
    }
    if (prior.serviceKey !== input.serviceKey) {
      throw new BadRequestException('serviceKey cannot change for an update request');
    }
    await this.assertNoPendingForService(input.serviceKey);
    const saved = await this.requests.save(
      this.requests.create({
        serviceKey: input.serviceKey,
        kind: 'update',
        status: 'pending',
        revision: prior.revision + 1,
        requestSecretHash: prior.requestSecretHash,
        requesterName: input.requesterName ?? prior.requesterName,
        requesterEmail: input.requesterEmail ?? prior.requesterEmail,
        requestedSpecJson: this.spec(input),
        requestIp,
      }),
    );
    return { request: this.safeRequest(saved) };
  }

  async list(status?: string) {
    const requests = await this.requests.find({
      where: status ? { status: status as never } : undefined,
      order: { createdAt: 'DESC' },
    });
    return requests.map((request) => this.safeRequest(request));
  }

  async get(id: string) {
    return this.safeRequest(await this.findById(id));
  }

  async assertManualCoreSpecEditAllowed(serviceId: string): Promise<void> {
    const approved = await this.requests.findBy({ status: 'approved' });
    const hasApprovedSpec = approved.some((request) => {
      const snapshot = request.approvedSnapshotJson as { serviceId?: string } | null;
      return snapshot?.serviceId === serviceId;
    });
    if (hasApprovedSpec) {
      throw new ConflictException(
        'Approved service specs must be changed through a service onboarding update request',
      );
    }
  }

  async approve(id: string, actorAccountId: string) {
    const request = await this.findPending(id);
    const spec = request.requestedSpecJson as unknown as CreateServiceOnboardingRequestDto;
    const service = await this.upsertService(spec);
    const createdSecrets: Record<string, unknown>[] = [];

    for (const permission of spec.permissions ?? []) {
      const existing = await this.permissions.findOneBy({
        serviceId: service.id,
        key: permission.key,
      });
      if (!existing) {
        await this.permissionsService.create(service.id, permission);
      } else {
        existing.label = permission.label;
        existing.description = permission.description ?? '';
        existing.status = 'active';
        await this.permissions.save(existing);
      }
    }

    for (const clientSpec of spec.oidcClients ?? []) {
      const existing = await this.clients.findOneBy({ clientId: clientSpec.clientId });
      const clientSecret =
        clientSpec.clientType === 'confidential' ? this.generateSecret() : undefined;
      const input = {
        clientId: clientSpec.clientId,
        clientType: clientSpec.clientType,
        clientSecret,
        redirectUris: clientSpec.redirectUris,
        postLogoutRedirectUris: clientSpec.postLogoutRedirectUris ?? [],
        allowedGrantTypes: ['authorization_code', 'refresh_token'],
        allowedScopes: clientSpec.allowedScopes ?? [
          'openid',
          'profile',
          'email',
          'service.permission',
        ],
        requirePkce: clientSpec.requirePkce ?? true,
      };
      if (existing && existing.serviceId === service.id) {
        await this.clientsService.update(service.id, existing.id, input);
      } else if (!existing) {
        await this.clientsService.create(service.id, input);
      } else {
        throw new ConflictException(`OIDC client ${clientSpec.clientId} is owned by another service`);
      }
      if (clientSecret) {
        createdSecrets.push({
          kind: 'oidc_client',
          clientId: clientSpec.clientId,
          clientSecret,
        });
      }
    }

    for (const credentialSpec of spec.serviceCredentials ?? []) {
      const credential = await this.credentialsService.create(service.id, {
        name: credentialSpec.name,
        description: credentialSpec.description,
        scopes: credentialSpec.scopes,
      });
      createdSecrets.push({
        kind: 'service_credential',
        keyId: credential.keyId,
        name: credential.name,
        secret: credential.secret,
      });
    }

    request.status = 'approved';
    request.approvedSnapshotJson = {
      ...spec,
      serviceId: service.id,
      approvedAt: new Date().toISOString(),
    };
    request.decidedByAccountId = actorAccountId;
    request.decidedAt = new Date();
    const saved = await this.requests.save(request);
    await this.auditLogs.record({
      actorAccountId,
      action: 'service_onboarding.approve',
      targetType: 'service_onboarding_request',
      targetId: saved.id,
      afterJson: this.safeRequest(saved),
    });
    return {
      request: this.safeRequest(saved),
      secrets: createdSecrets,
    };
  }

  async reject(
    id: string,
    actorAccountId: string,
    input: RejectServiceOnboardingRequestDto,
  ) {
    const request = await this.findPending(id);
    request.status = 'rejected';
    request.decisionReason = input.reason ?? null;
    request.decidedByAccountId = actorAccountId;
    request.decidedAt = new Date();
    const saved = await this.requests.save(request);
    await this.auditLogs.record({
      actorAccountId,
      action: 'service_onboarding.reject',
      targetType: 'service_onboarding_request',
      targetId: saved.id,
      afterJson: this.safeRequest(saved),
    });
    return this.safeRequest(saved);
  }

  private async upsertService(spec: CreateServiceOnboardingRequestDto) {
    const existing = await this.serviceRegistry.findByKey(spec.serviceKey);
    if (!existing) {
      return this.serviceRegistry.create({
        serviceKey: spec.serviceKey,
        name: spec.name,
        description: spec.description,
      });
    }
    existing.name = spec.name;
    existing.description = spec.description ?? '';
    existing.status = 'active';
    return this.serviceRegistry.update(existing.id, {
      name: existing.name,
      description: existing.description,
      status: 'active',
    });
  }

  private async assertNoPendingForService(serviceKey: string): Promise<void> {
    if (await this.requests.existsBy({ serviceKey, status: 'pending' })) {
      throw new ConflictException('A pending onboarding request already exists for this service');
    }
  }

  private async assertPublicRateLimit(requestIp: string | null): Promise<void> {
    if (!requestIp) {
      return;
    }
    const recent = await this.requests.countBy({
      requestIp,
      createdAt: MoreThan(new Date(Date.now() - PUBLIC_REQUEST_WINDOW_MS)),
    });
    if (recent >= PUBLIC_REQUEST_IP_LIMIT) {
      throw new BadRequestException('Too many onboarding requests from this IP');
    }
  }

  private async findById(id: string): Promise<ServiceOnboardingRequestEntity> {
    const request = await this.requests.findOneBy({ id });
    if (!request) {
      throw new NotFoundException('Service onboarding request not found');
    }
    return request;
  }

  private async findPending(id: string): Promise<ServiceOnboardingRequestEntity> {
    const request = await this.findById(id);
    if (request.status !== 'pending') {
      throw new ConflictException('Service onboarding request is not pending');
    }
    return request;
  }

  private spec(input: CreateServiceOnboardingRequestDto): Record<string, unknown> {
    return {
      serviceKey: input.serviceKey,
      name: input.name,
      description: input.description ?? '',
      requesterName: input.requesterName ?? null,
      requesterEmail: input.requesterEmail ?? null,
      permissions: input.permissions ?? [],
      oidcClients: input.oidcClients ?? [],
      serviceCredentials: input.serviceCredentials ?? [],
    };
  }

  private safeRequest(request: ServiceOnboardingRequestEntity): Record<string, unknown> {
    return {
      id: request.id,
      serviceKey: request.serviceKey,
      kind: request.kind,
      status: request.status,
      revision: request.revision,
      requesterName: request.requesterName,
      requesterEmail: request.requesterEmail,
      requestedSpec: request.requestedSpecJson,
      approvedSnapshot: request.approvedSnapshotJson,
      decisionReason: request.decisionReason,
      decidedByAccountId: request.decidedByAccountId,
      decidedAt: request.decidedAt,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    };
  }

  private generateSecret(): string {
    return randomBytes(32).toString('base64url');
  }
}
