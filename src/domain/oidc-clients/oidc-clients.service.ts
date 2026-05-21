import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { OidcClientEntity } from '../../database/entities/oidc-client.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ServiceRegistryService } from '../service-registry/service-registry.service';
import {
  CreateOidcClientDto,
  RotateClientSecretDto,
  UpdateOidcClientDto,
} from './dto/oidc-client.dto';

@Injectable()
export class OidcClientsService {
  constructor(
    @InjectRepository(OidcClientEntity)
    private readonly clients: Repository<OidcClientEntity>,
    private readonly services: ServiceRegistryService,
    private readonly passwordService: PasswordService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  listByService(serviceId: string): Promise<OidcClientEntity[]> {
    return this.clients.find({
      where: { serviceId },
      order: { createdAt: 'DESC' },
    });
  }

  async findByClientId(clientId: string): Promise<OidcClientEntity> {
    const client = await this.clients.findOne({ where: { clientId } });
    if (!client) {
      throw new NotFoundException('OIDC client not found');
    }
    return client;
  }

  async create(serviceId: string, input: CreateOidcClientDto): Promise<OidcClientEntity> {
    if (await this.clients.existsBy({ clientId: input.clientId })) {
      throw new ConflictException('Client id already exists');
    }
    const service = await this.services.findById(serviceId);
    if (input.clientType === 'confidential' && !input.clientSecret) {
      throw new BadRequestException('Confidential clients require a secret');
    }
    const client = await this.clients.save(
      this.clients.create({
        serviceId,
        service,
        clientId: input.clientId,
        clientType: input.clientType,
        clientSecretHash: input.clientSecret
          ? await this.passwordService.hash(input.clientSecret)
          : null,
        redirectUris: input.redirectUris,
        postLogoutRedirectUris: input.postLogoutRedirectUris ?? [],
        allowedGrantTypes: input.allowedGrantTypes ?? [
          'authorization_code',
          'refresh_token',
        ],
        allowedScopes: input.allowedScopes ?? [
          'openid',
          'profile',
          'email',
          'service.permission',
        ],
        requirePkce: input.requirePkce ?? true,
        status: 'active',
      }),
    );
    await this.auditLogs.record({
      action: 'oidc_client.create',
      targetType: 'oidc_client',
      targetId: client.id,
      afterJson: this.safeClient(client),
    });
    return client;
  }

  async update(
    serviceId: string,
    clientId: string,
    input: UpdateOidcClientDto,
  ): Promise<OidcClientEntity> {
    const client = await this.findOwnedClient(serviceId, clientId);
    const before = this.safeClient(client);
    Object.assign(client, input);
    const saved = await this.clients.save(client);
    await this.auditLogs.record({
      action: 'oidc_client.update',
      targetType: 'oidc_client',
      targetId: saved.id,
      beforeJson: before,
      afterJson: this.safeClient(saved),
    });
    return saved;
  }

  async rotateSecret(
    serviceId: string,
    clientId: string,
    input: RotateClientSecretDto,
  ): Promise<void> {
    const client = await this.findOwnedClient(serviceId, clientId);
    if (client.clientType !== 'confidential') {
      throw new BadRequestException('Only confidential clients have secrets');
    }
    client.clientSecretHash = await this.passwordService.hash(input.clientSecret);
    await this.clients.save(client);
    await this.auditLogs.record({
      action: 'oidc_client.rotate_secret',
      targetType: 'oidc_client',
      targetId: client.id,
    });
  }

  async validateClientSecret(client: OidcClientEntity, secret?: string): Promise<void> {
    if (client.clientType === 'public') {
      return;
    }
    if (!secret || !client.clientSecretHash) {
      throw new UnauthorizedException('Client secret is required');
    }
    if (!(await this.passwordService.verify(client.clientSecretHash, secret))) {
      throw new UnauthorizedException('Invalid client secret');
    }
  }

  safeClient(client: OidcClientEntity): Record<string, unknown> {
    return {
      id: client.id,
      serviceId: client.serviceId,
      clientId: client.clientId,
      clientType: client.clientType,
      redirectUris: client.redirectUris,
      postLogoutRedirectUris: client.postLogoutRedirectUris,
      allowedGrantTypes: client.allowedGrantTypes,
      allowedScopes: client.allowedScopes,
      requirePkce: client.requirePkce,
      status: client.status,
    };
  }

  private async findOwnedClient(
    serviceId: string,
    clientId: string,
  ): Promise<OidcClientEntity> {
    const client = await this.clients.findOne({ where: { id: clientId, serviceId } });
    if (!client) {
      throw new NotFoundException('OIDC client not found');
    }
    return client;
  }
}
