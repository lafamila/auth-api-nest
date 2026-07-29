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
  UpdateServiceCredentialDto,
} from './dto/service-credential.dto';
import { AuthenticatedServiceCredential } from './service-credential-request';
import {
  SERVICE_CREDENTIAL_VERIFICATION_REASON_BY_DETAIL,
  ServiceCredentialVerificationDetail,
  ServiceCredentialVerificationResult,
  VerifyServiceCredentialContext,
} from './service-credential-verification';

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

  async update(
    serviceId: string,
    credentialId: string,
    input: UpdateServiceCredentialDto,
  ): Promise<ServiceCredentialView> {
    const credential = await this.findOwnedCredential(serviceId, credentialId);
    const before = this.toView(credential);
    if (input.name !== undefined) {
      credential.name = input.name;
    }
    if (input.description !== undefined) {
      credential.description = input.description;
    }
    if (input.scopes !== undefined) {
      credential.scopes = this.normalizeScopes(input.scopes);
    }
    if (input.expiresAt !== undefined) {
      credential.expiresAt = input.expiresAt;
    }
    if (input.status !== undefined) {
      credential.status = input.status;
      credential.disabledAt =
        input.status === 'disabled' ? credential.disabledAt ?? new Date() : null;
    }
    const saved = await this.credentials.save(credential);
    const safeCredential = this.toView(saved);
    await this.auditLogs.record({
      action: 'service_credential.update',
      targetType: 'service_credential',
      targetId: saved.id,
      beforeJson: before as unknown as Record<string, unknown>,
      afterJson: safeCredential as unknown as Record<string, unknown>,
    });
    return safeCredential;
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

  /**
   * 제3자가 제시한 credential 을 검증한다. 호출자 자신을 인증하는 `authenticate` 와 달리
   * 예외를 던지지 않고 판정값을 돌려주므로, 서비스 간 인증 창구로 재사용할 수 있다.
   */
  async verifyPresented(
    keyId: string,
    secret: string,
    context: VerifyServiceCredentialContext,
  ): Promise<ServiceCredentialVerificationResult> {
    const credential = await this.credentials.findOne({
      where: { keyId },
      relations: { service: true },
    });
    const detail = credential
      ? await this.resolveVerificationDetail(credential, secret, context)
      : 'not_found';
    const reason =
      detail === 'ok'
        ? null
        : SERVICE_CREDENTIAL_VERIFICATION_REASON_BY_DETAIL[detail];

    await this.auditLogs.record({
      action: 'service_credential.verify',
      targetType: 'service_credential',
      targetId: credential?.id ?? null,
      afterJson: {
        valid: detail === 'ok',
        reason,
        detail,
        targetKeyId: keyId,
        requiredScope: context.requiredScope ?? null,
        callerCredentialId: context.caller.credentialId,
        callerKeyId: context.caller.keyId,
        callerServiceKey: context.caller.serviceKey,
      },
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    if (!credential || reason) {
      return { valid: false, reason: reason ?? 'invalid_credential' };
    }
    await this.markUsed(credential.id, context.ipAddress ?? null);
    return {
      valid: true,
      serviceKey: credential.service.serviceKey,
      scopes: [...credential.scopes],
      status: credential.status,
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

  private async resolveVerificationDetail(
    credential: ServiceCredentialEntity,
    secret: string,
    context: VerifyServiceCredentialContext,
  ): Promise<ServiceCredentialVerificationDetail> {
    // secret 검증을 먼저 한다 — 그래야 존재·비활성·소속 정보가 secret 을 모르는 호출자에게 새지 않는다.
    const secretMatches = await this.passwordService.verify(
      credential.secretHash,
      secret,
    );
    if (!secretMatches) {
      return 'secret_mismatch';
    }
    if (credential.service.serviceKey !== context.caller.serviceKey) {
      return 'cross_service';
    }
    const usability = this.evaluateUsability(credential);
    if (usability !== 'usable') {
      return usability;
    }
    if (
      context.requiredScope &&
      !credential.scopes.includes(context.requiredScope)
    ) {
      return 'scope_missing';
    }
    return 'ok';
  }

  private evaluateUsability(
    credential: ServiceCredentialEntity,
  ): 'usable' | 'status_disabled' | 'service_inactive' | 'expired' {
    if (credential.status !== 'active') {
      return 'status_disabled';
    }
    if (credential.service.status !== 'active') {
      return 'service_inactive';
    }
    if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) {
      return 'expired';
    }
    return 'usable';
  }

  private assertCredentialUsable(credential: ServiceCredentialEntity): void {
    switch (this.evaluateUsability(credential)) {
      case 'status_disabled':
        throw new UnauthorizedException('Service credential is disabled');
      case 'service_inactive':
        throw new UnauthorizedException('Service is inactive');
      case 'expired':
        throw new UnauthorizedException('Service credential has expired');
      default:
        return;
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
