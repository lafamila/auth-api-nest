import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { AccountEntity } from '../database/entities/account.entity';
import { TokenService } from '../oidc/token.service';

export type NotificationAppRequest = Request & {
  notificationAccount?: AccountEntity;
};

@Injectable()
export class NotificationAppGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    @InjectRepository(AccountEntity)
    private readonly accounts: Repository<AccountEntity>,
    @InjectRepository(AccountServicePermissionEntity)
    private readonly permissions: Repository<AccountServicePermissionEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<NotificationAppRequest>();
    const authorization = request.header('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer access token is required');
    }
    let claims: Record<string, unknown>;
    try {
      claims = this.tokens.verifyAccessToken(authorization.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
    if (
      claims.aud !== 'service:notification' ||
      typeof claims.sub !== 'string'
    ) {
      throw new UnauthorizedException('Invalid notification token audience');
    }
    const serviceClaim = claims['https://lafamila.xyz/claims/service'];
    if (
      !serviceClaim ||
      typeof serviceClaim !== 'object' ||
      (serviceClaim as { key?: unknown }).key !== 'notification'
    ) {
      throw new UnauthorizedException('Invalid notification service claim');
    }
    const account = await this.accounts.findOneBy({
      id: claims.sub,
      status: 'active',
    });
    if (!account) {
      throw new UnauthorizedException('Notification account is unavailable');
    }
    const assignment = await this.permissions
      .createQueryBuilder('permission')
      .innerJoin('permission.service', 'service')
      .where('permission.account_id = :accountId', { accountId: account.id })
      .andWhere('permission.status = :status', { status: 'active' })
      .andWhere('service.service_key = :serviceKey', {
        serviceKey: 'notification',
      })
      .andWhere('service.status = :serviceStatus', { serviceStatus: 'active' })
      .getOne();
    if (!assignment) {
      throw new UnauthorizedException(
        'Notification service access is unavailable',
      );
    }
    request.notificationAccount = account;
    return true;
  }
}
