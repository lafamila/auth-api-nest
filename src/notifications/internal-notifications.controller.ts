import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ServiceCredentialRequest } from '../domain/service-credentials/service-credential-request';
import { ServiceCredentialsService } from '../domain/service-credentials/service-credentials.service';
import { InternalServiceCredentialsGuard } from '../internal/internal-service-credentials.guard';
import {
  InternalNotificationDevicesQueryDto,
  SendNotificationDto,
} from './dto/notification.dto';
import { NotificationSendService } from './notification-send.service';

@UseGuards(InternalServiceCredentialsGuard)
@Controller('api/internal')
export class InternalNotificationsController {
  constructor(
    private readonly notifications: NotificationSendService,
    private readonly credentials: ServiceCredentialsService,
  ) {}

  @Get('notification-devices')
  listDevices(
    @Req() request: ServiceCredentialRequest,
    @Query() query: InternalNotificationDevicesQueryDto,
  ) {
    const credential = this.credential(request);
    if (!this.credentials.hasScope(credential, 'notifications.devices.read')) {
      throw new ForbiddenException('notification_scope_missing');
    }
    return this.notifications.listDevices(credential, query.accountId);
  }

  @Post('notifications')
  send(
    @Req() request: ServiceCredentialRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: SendNotificationDto,
  ) {
    const credential = this.credential(request);
    if (!this.credentials.hasScope(credential, 'notifications.send')) {
      throw new ForbiddenException('notification_scope_missing');
    }
    if (!idempotencyKey) {
      throw new ForbiddenException('idempotency_key_required');
    }
    return this.notifications.send(credential, idempotencyKey, body);
  }

  private credential(request: ServiceCredentialRequest) {
    if (!request.serviceCredential) {
      throw new UnauthorizedException('Service credential context is required');
    }
    return request.serviceCredential;
  }
}
