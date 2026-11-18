import { IsIn, IsOptional, IsString, ValidateIf } from 'class-validator';
import {
  SERVICE_CATEGORY_KEYS,
  ServiceCategory,
  ServiceStatus,
} from '../../../database/entities/service.entity';

export class CreateServiceDto {
  @IsString()
  serviceKey!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(SERVICE_CATEGORY_KEYS)
  category?: ServiceCategory;
}

export class UpdateServiceDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['active', 'disabled', 'archived'])
  status?: ServiceStatus;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(SERVICE_CATEGORY_KEYS)
  category?: ServiceCategory;
}
