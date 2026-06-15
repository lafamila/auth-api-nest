import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly adminAuth: AdminAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    await this.adminAuth.validateRequest(request);
    return true;
  }
}
