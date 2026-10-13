import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  NotificationAppGuard,
  NotificationAppRequest,
} from './notification-app.guard';
import { NotificationDevicesService } from './notification-devices.service';
import {
  NotificationInboxQueryDto,
  RegisterNotificationDeviceDto,
  SetNotificationSubscriptionDto,
  UpdateNotificationDeviceDto,
} from './dto/notification.dto';
import { NotificationInboxService } from './notification-inbox.service';

@UseGuards(NotificationAppGuard)
@Controller('api/notifications')
export class NotificationAppController {
  constructor(
    private readonly devices: NotificationDevicesService,
    private readonly inbox: NotificationInboxService,
  ) {}

  @Post('devices')
  registerDevice(
    @Req() request: NotificationAppRequest,
    @Body() body: RegisterNotificationDeviceDto,
  ) {
    return this.devices.register(request.notificationAccount!.id, body);
  }

  @Get('devices')
  listDevices(@Req() request: NotificationAppRequest) {
    return this.devices.list(request.notificationAccount!.id);
  }

  @Patch('devices/:deviceId')
  updateDevice(
    @Req() request: NotificationAppRequest,
    @Param('deviceId') deviceId: string,
    @Body() body: UpdateNotificationDeviceDto,
  ) {
    return this.devices.update(request.notificationAccount!.id, deviceId, body);
  }

  @Delete('devices/:deviceId')
  @HttpCode(204)
  async deleteDevice(
    @Req() request: NotificationAppRequest,
    @Param('deviceId') deviceId: string,
  ): Promise<void> {
    await this.devices.remove(request.notificationAccount!.id, deviceId);
  }

  @Put('devices/:deviceId/subscriptions/:serviceKey')
  setDeviceSubscription(
    @Req() request: NotificationAppRequest,
    @Param('deviceId') deviceId: string,
    @Param('serviceKey') serviceKey: string,
    @Body() body: SetNotificationSubscriptionDto,
  ) {
    return this.devices.setSubscription(
      request.notificationAccount!.id,
      deviceId,
      serviceKey,
      body.enabled,
    );
  }

  @Put('subscriptions/:serviceKey')
  setAllDeviceSubscriptions(
    @Req() request: NotificationAppRequest,
    @Param('serviceKey') serviceKey: string,
    @Body() body: SetNotificationSubscriptionDto,
  ) {
    return this.devices.setSubscriptionForAllDevices(
      request.notificationAccount!.id,
      serviceKey,
      body.enabled,
    );
  }

  @Get('inbox')
  listInbox(
    @Req() request: NotificationAppRequest,
    @Query() query: NotificationInboxQueryDto,
  ) {
    return this.inbox.list(request.notificationAccount!.id, query);
  }

  @Get('inbox/:notificationId')
  inboxDetail(
    @Req() request: NotificationAppRequest,
    @Param('notificationId') notificationId: string,
  ) {
    return this.inbox.detail(request.notificationAccount!.id, notificationId);
  }

  @Delete('inbox/:notificationId')
  @HttpCode(204)
  async deleteInboxItem(
    @Req() request: NotificationAppRequest,
    @Param('notificationId') notificationId: string,
  ): Promise<void> {
    await this.inbox.remove(request.notificationAccount!.id, notificationId);
  }
}
