import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { NotificationPlatform } from '../../database/entities/notification-device.entity';

export class RegisterNotificationDeviceDto {
  @IsString()
  @Length(8, 200)
  installationId!: string;

  @IsString()
  @Length(1, 100)
  displayName!: string;

  @IsIn(['ios', 'android'])
  platform!: NotificationPlatform;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  appVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  buildNumber?: string;

  @IsString()
  @Length(20, 4096)
  pushToken!: string;
}

export class UpdateNotificationDeviceDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class SetNotificationSubscriptionDto {
  @IsBoolean()
  enabled!: boolean;
}

export class NotificationInboxQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 30;
}

export class NotificationDestinationDto {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  deviceIds?: string[];

  @IsOptional()
  @IsIn(['ios', 'android'])
  platform?: NotificationPlatform;
}

export class NotificationActionDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,63}$/)
  targetKey!: string;

  @IsString()
  @Length(1, 1000)
  path!: string;
}

export class SendNotificationDto {
  @IsUUID('4')
  accountId!: string;

  @IsString()
  @Length(1, 160)
  title!: string;

  @IsString()
  @Length(1, 4000)
  body!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationDestinationDto)
  destination?: NotificationDestinationDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationActionDto)
  action?: NotificationActionDto;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class InternalNotificationDevicesQueryDto {
  @IsUUID('4')
  accountId!: string;
}

export class OnboardingNotificationActionTargetDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,63}$/)
  targetKey!: string;

  @IsString()
  @MaxLength(1000)
  baseUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  fallbackUrl?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  allowedPaths!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  allowedCustomSchemes?: string[];
}

export class AdminNotificationPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 30;
}

export class AdminActionTargetStatusDto {
  @IsIn(['active', 'disabled'])
  status!: 'active' | 'disabled';
}
