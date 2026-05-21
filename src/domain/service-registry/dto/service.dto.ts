import { IsIn, IsOptional, IsString } from 'class-validator';
import { ServiceStatus } from '../../../database/entities/service.entity';

export class CreateServiceDto {
  @IsString()
  serviceKey!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
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
}
