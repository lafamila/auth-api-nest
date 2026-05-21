import { IsIn, IsInt, IsOptional, IsString, IsUUID } from 'class-validator';
import { PermissionStatus } from '../../../database/entities/service-permission-definition.entity';

export class CreatePermissionDto {
  @IsString()
  key!: string;

  @IsString()
  label!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdatePermissionDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['active', 'deprecated', 'removed'])
  status?: PermissionStatus;
}

export class MigratePermissionDto {
  @IsUUID()
  targetPermissionId!: string;
}
