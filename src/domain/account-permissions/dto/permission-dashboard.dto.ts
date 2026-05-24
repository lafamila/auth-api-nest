import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { PermissionStatus } from '../../../database/entities/service-permission-definition.entity';

export interface PermissionDashboardRowDto {
  id: string;
  accountId: string;
  loginId: string;
  accountName: string;
  email: string;
  serviceId: string;
  serviceKey: string;
  serviceName: string;
  permissionDefinitionId: string;
  permissionKey: string;
  permissionLabel: string;
  permissionStatus: PermissionStatus;
  grantedAt: Date;
  grantedByAccountId: string | null;
}

export class PermissionDashboardQueryDto {
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
  pageSize = 25;

  @IsOptional()
  @IsString()
  serviceKey?: string;
}

export interface PermissionDashboardPageDto {
  items: PermissionDashboardRowDto[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
