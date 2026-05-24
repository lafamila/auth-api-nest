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
  OidcClientView,
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

  async listByService(serviceId: string): Promise<OidcClientView[]> {
    const clients = await this.clients.find({
      where: { serviceId },
      order: { createdAt: 'DESC' },
    });
    return clients.map((client) => this.safeClient(client));
  }

  async findByClientId(clientId: string): Promise<OidcClientEntity> {
    const client = await this.clients.findOne({ where: { clientId } });
    if (!client) {
      throw new NotFoundException('OIDC client not found');
    }
    return client;
  }

  async create(serviceId: string, input: CreateOidcClientDto): Promise<OidcClientView> {
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
      afterJson: this.safeClient(client) as unknown as Record<string, unknown>,
    });
    return this.safeClient(client);
  }

  async update(
    serviceId: string,
    clientId: string,
    input: UpdateOidcClientDto,
  ): Promise<OidcClientView> {
    const client = await this.findOwnedClient(serviceId, clientId);
    if (input.clientType === 'confidential' && !input.clientSecret && !client.clientSecretHash) {
      throw new BadRequestException('Confidential clients require a secret');
    }
    const before = this.safeClient(client);
    if (input.clientType !== undefined) {
      client.clientType = input.clientType;
      if (input.clientType === 'public') {
        client.clientSecretHash = null;
      }
    }
    if (input.clientSecret !== undefined) {
      client.clientSecretHash = await this.passwordService.hash(input.clientSecret);
    }
    if (input.status !== undefined) {
      client.status = input.status;
    }
    if (input.redirectUris !== undefined) {
      client.redirectUris = input.redirectUris;
    }
    if (input.postLogoutRedirectUris !== undefined) {
      client.postLogoutRedirectUris = input.postLogoutRedirectUris;
    }
    if (input.allowedGrantTypes !== undefined) {
      client.allowedGrantTypes = input.allowedGrantTypes;
    }
    if (input.allowedScopes !== undefined) {
      client.allowedScopes = input.allowedScopes;
    }
    if (input.requirePkce !== undefined) {
      client.requirePkce = input.requirePkce;
    }
    const saved = await this.clients.save(client);
    await this.auditLogs.record({
      action: 'oidc_client.update',
      targetType: 'oidc_client',
      targetId: saved.id,
      beforeJson: before as unknown as Record<string, unknown>,
      afterJson: this.safeClient(saved) as unknown as Record<string, unknown>,
    });
    return this.safeClient(saved);
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

  safeClient(client: OidcClientEntity): OidcClientView {
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
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
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
