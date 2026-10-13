import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AdminGuard } from '../admin/admin.guard';
import {
  AdminActionTargetStatusDto,
  AdminNotificationPageQueryDto,
} from './dto/notification.dto';
import { NotificationActionTargetsService } from './notification-action-targets.service';
import { NotificationAdminService } from './notification-admin.service';

type AdminRequest = Request & { adminAccount?: { id: string } };

@UseGuards(AdminGuard)
@Controller('api/admin/notifications')
export class AdminNotificationsController {
  constructor(
    private readonly notifications: NotificationAdminService,
    private readonly actions: NotificationActionTargetsService,
  ) {}

  @Get('devices')
  listDevices(@Query() query: AdminNotificationPageQueryDto) {
    return this.notifications.listDevices(query);
  }

  @Get('subscriptions')
  listSubscriptions(@Query() query: AdminNotificationPageQueryDto) {
    return this.notifications.listSubscriptions(query);
  }

  @Get('messages')
  listNotifications(@Query() query: AdminNotificationPageQueryDto) {
    return this.notifications.listNotifications(query);
  }

  @Get('deliveries')
  listDeliveries(@Query() query: AdminNotificationPageQueryDto) {
    return this.notifications.listDeliveries(query);
  }

  @Get('action-targets')
  listActionTargets() {
    return this.actions.list();
  }

  @Post('devices/:deviceId/disable')
  disableDevice(
    @Param('deviceId') deviceId: string,
    @Req() request: AdminRequest,
  ) {
    return this.notifications.disableDevice(deviceId, request.adminAccount!.id);
  }

  @Post('subscriptions/:subscriptionId/revoke')
  revokeSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @Req() request: AdminRequest,
  ) {
    return this.notifications.revokeSubscription(
      subscriptionId,
      request.adminAccount!.id,
    );
  }

  @Patch('action-targets/:targetId')
  setActionTargetStatus(
    @Param('targetId') targetId: string,
    @Body() body: AdminActionTargetStatusDto,
    @Req() request: AdminRequest,
  ) {
    return this.actions.setStatus(
      targetId,
      body.status,
      request.adminAccount!.id,
    );
  }
}
