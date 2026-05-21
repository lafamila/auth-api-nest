import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AppConfigService } from '../config/app-config.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = request.header('x-admin-key');
    if (apiKey && apiKey === this.config.adminApiKey) {
      return true;
    }
    throw new UnauthorizedException('Admin API key is required');
  }
}
