import {
  ArrayNotEmpty,
  IsArray,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ServiceCredentialScope,
  ServiceCredentialStatus,
} from '../../../database/entities/service-credential.entity';

export class CreateServiceCredentialDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['account.search', 'permission.read'], { each: true })
  scopes!: ServiceCredentialScope[];

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date | null;
}

export class UpdateServiceCredentialDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['account.search', 'permission.read'], { each: true })
  scopes?: ServiceCredentialScope[];

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: ServiceCredentialStatus;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date | null;
}

export interface ServiceCredentialView {
  id: string;
  keyId: string;
  serviceId: string;
  serviceKey: string;
  name: string;
  description: string;
  scopes: ServiceCredentialScope[];
  status: ServiceCredentialStatus;
  lastUsedAt: Date | null;
  lastUsedFrom: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  rotatedAt: Date | null;
  disabledAt: Date | null;
}

export interface ServiceCredentialSecretView extends ServiceCredentialView {
  secret: string;
}
