import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import {
  ServiceCredentialEntity,
  ServiceCredentialScope,
} from '../../database/entities/service-credential.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ServiceRegistryService } from '../service-registry/service-registry.service';
import {
  CreateServiceCredentialDto,
  ServiceCredentialSecretView,
  ServiceCredentialView,
} from './dto/service-credential.dto';
import { AuthenticatedServiceCredential } from './service-credential-request';

@Injectable()
export class ServiceCredentialsService {
  constructor(
    @InjectRepository(ServiceCredentialEntity)
    private readonly credentials: Repository<ServiceCredentialEntity>,
    private readonly services: ServiceRegistryService,
    private readonly passwordService: PasswordService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async create(
    serviceId: string,
    input: CreateServiceCredentialDto,
  ): Promise<ServiceCredentialSecretView> {
    const service = await this.services.findById(serviceId);
    const secret = this.generateSecret();
    const credential = await this.credentials.save(
      this.credentials.create({
        service,
        serviceId,
        keyId: await this.generateKeyId(service.serviceKey),
        secretHash: await this.passwordService.hash(secret),
        name: input.name,
        description: input.description ?? '',
        scopes: this.normalizeScopes(input.scopes),
        status: 'active',
        expiresAt: input.expiresAt ?? null,
      }),
    );
    const safeCredential = this.toView(credential);
    await this.auditLogs.record({
      action: 'service_credential.create',
      targetType: 'service_credential',
      targetId: credential.id,
      afterJson: safeCredential as unknown as Record<string, unknown>,
    });
    return {
      ...safeCredential,
      secret,
    };
  }

  async listByService(serviceId: string): Promise<ServiceCredentialView[]> {
    await this.services.findById(serviceId);
    const credentials = await this.credentials.find({
      where: { serviceId },
      order: { createdAt: 'DESC' },
    });
    return credentials.map((credential) => this.toView(credential));
  }

  async rotate(
    serviceId: string,
    credentialId: string,
  ): Promise<ServiceCredentialSecretView> {
    const credential = await this.findOwnedCredential(serviceId, credentialId);
    if (credential.status !== 'active') {
      throw new BadRequestException('Disabled credentials cannot be rotated');
    }
    const before = this.toView(credential);
    const secret = this.generateSecret();
    credential.secretHash = await this.passwordService.hash(secret);
    credential.rotatedAt = new Date();
    const saved = await this.credentials.save(credential);
    const safeCredential = this.toView(saved);
    await this.auditLogs.record({
      action: 'service_credential.rotate',
      targetType: 'service_credential',
      targetId: saved.id,
      beforeJson: before as unknown as Record<string, unknown>,
      afterJson: safeCredential as unknown as Record<string, unknown>,
    });
    return {
      ...safeCredential,
      secret,
    };
  }

  async disable(serviceId: string, credentialId: string): Promise<ServiceCredentialView> {
    const credential = await this.findOwnedCredential(serviceId, credentialId);
    if (credential.status !== 'disabled') {
      const before = this.toView(credential);
      credential.status = 'disabled';
      credential.disabledAt = credential.disabledAt ?? new Date();
      const saved = await this.credentials.save(credential);
      const safeCredential = this.toView(saved);
      await this.auditLogs.record({
        action: 'service_credential.disable',
        targetType: 'service_credential',
        targetId: saved.id,
        beforeJson: before as unknown as Record<string, unknown>,
        afterJson: safeCredential as unknown as Record<string, unknown>,
      });
      return safeCredential;
    }
    return this.toView(credential);
  }

  async authenticate(
    keyId: string,
    secret: string,
  ): Promise<AuthenticatedServiceCredential> {
    const credential = await this.credentials.findOne({
      where: { keyId },
      relations: { service: true },
    });
    if (!credential) {
      throw new UnauthorizedException('Invalid service credential');
    }
    this.assertCredentialUsable(credential);
    const isValid = await this.passwordService.verify(credential.secretHash, secret);
    if (!isValid) {
      throw new UnauthorizedException('Invalid service credential');
    }
    return {
      credentialId: credential.id,
      keyId: credential.keyId,
      serviceId: credential.serviceId,
      serviceKey: credential.service.serviceKey,
      scopes: credential.scopes,
    };
  }

  async markUsed(credentialId: string, lastUsedFrom: string | null): Promise<void> {
    await this.credentials.update(
      { id: credentialId },
      {
        lastUsedAt: new Date(),
        lastUsedFrom,
      },
    );
  }

  hasScope(
    credential: AuthenticatedServiceCredential,
    scope: ServiceCredentialScope,
  ): boolean {
    return credential.scopes.includes(scope);
  }

  private toView(credential: ServiceCredentialEntity): ServiceCredentialView {
    return {
      id: credential.id,
      keyId: credential.keyId,
      serviceId: credential.serviceId,
      serviceKey: credential.service.serviceKey,
      name: credential.name,
      description: credential.description,
      scopes: [...credential.scopes],
      status: credential.status,
      lastUsedAt: credential.lastUsedAt,
      lastUsedFrom: credential.lastUsedFrom,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
      expiresAt: credential.expiresAt,
      rotatedAt: credential.rotatedAt,
      disabledAt: credential.disabledAt,
    };
  }

  private async findOwnedCredential(
    serviceId: string,
    credentialId: string,
  ): Promise<ServiceCredentialEntity> {
    const credential = await this.credentials.findOne({
      where: { id: credentialId, serviceId },
      relations: { service: true },
    });
    if (!credential) {
      throw new NotFoundException('Service credential not found');
    }
    return credential;
  }

  private assertCredentialUsable(credential: ServiceCredentialEntity): void {
    if (credential.status !== 'active') {
      throw new UnauthorizedException('Service credential is disabled');
    }
    if (credential.service.status !== 'active') {
      throw new UnauthorizedException('Service is inactive');
    }
    if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Service credential has expired');
    }
  }

  private async generateKeyId(serviceKey: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const keyId = `asc_${serviceKey}_${randomBytes(8).toString('hex')}`;
      if (!(await this.credentials.existsBy({ keyId }))) {
        return keyId;
      }
    }
    throw new BadRequestException('Could not allocate a unique service credential key id');
  }

  private generateSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  private normalizeScopes(scopes: ServiceCredentialScope[]): ServiceCredentialScope[] {
    return [...new Set(scopes)];
  }
}
