import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsIn } from 'class-validator';
import { ListPermissionWebhookDeliveriesDto } from '../../domain/permission-webhooks/dto/permission-webhook-admin.dto';
import { PermissionWebhooksService } from '../../domain/permission-webhooks/permission-webhooks.service';
import { AdminGuard } from '../admin.guard';

class UpdatePermissionWebhookStatusDto {
  @IsIn(['active', 'disabled'])
  status!: 'active' | 'disabled';
}

@UseGuards(AdminGuard)
@Controller('api/admin/services/:serviceId/webhook')
export class AdminPermissionWebhooksController {
  constructor(private readonly webhooks: PermissionWebhooksService) {}

  @Get()
  get(@Param('serviceId') serviceId: string) {
    return this.webhooks.findSubscription(serviceId);
  }

  @Patch()
  updateStatus(
    @Param('serviceId') serviceId: string,
    @Body() body: UpdatePermissionWebhookStatusDto,
  ) {
    return this.webhooks.setStatus(serviceId, body.status);
  }

  @Post('rotate')
  rotate(@Param('serviceId') serviceId: string) {
    return this.webhooks.rotateSecret(serviceId);
  }

  @Get('deliveries')
  listDeliveries(
    @Param('serviceId') serviceId: string,
    @Query() query: ListPermissionWebhookDeliveriesDto,
  ) {
    return this.webhooks.listDeliveries(
      serviceId,
      query.status,
      query.page,
      query.pageSize,
    );
  }

  @Post('deliveries/:eventId/retry')
  retry(
    @Param('serviceId') serviceId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.webhooks.retryDelivery(serviceId, eventId);
  }
}
