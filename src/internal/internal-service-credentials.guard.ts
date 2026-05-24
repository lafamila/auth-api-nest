import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { ServiceCredentialRequest } from '../domain/service-credentials/service-credential-request';
import { ServiceCredentialsService } from '../domain/service-credentials/service-credentials.service';

@Injectable()
export class InternalServiceCredentialsGuard implements CanActivate {
  constructor(private readonly credentials: ServiceCredentialsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ServiceCredentialRequest>();
    const keyId = request.header('x-auth-service-key-id');
    const secret = request.header('x-auth-service-secret');
    if (!keyId || !secret) {
      throw new UnauthorizedException('Service credential headers are required');
    }

    const authenticated = await this.credentials.authenticate(keyId, secret);
    request.serviceCredential = authenticated;
    await this.credentials.markUsed(
      authenticated.credentialId,
      this.resolveRemoteAddress(request),
    );
    return true;
  }

  private resolveRemoteAddress(request: Request): string | null {
    const forwardedFor = request.header('x-forwarded-for');
    if (forwardedFor) {
      const firstForwarded = forwardedFor
        .split(',')
        .map((part) => part.trim())
        .find(Boolean);
      if (firstForwarded) {
        return firstForwarded;
      }
    }
    return request.ip || request.socket.remoteAddress || null;
  }
}
