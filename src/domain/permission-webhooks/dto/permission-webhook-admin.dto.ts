import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PermissionWebhookDeliveryStatus } from '../../../database/entities/permission-webhook-outbox.entity';

export class ListPermissionWebhookDeliveriesDto {
  @IsOptional()
  @IsIn(['pending', 'delivered', 'exhausted'])
  status?: PermissionWebhookDeliveryStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
