import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ServiceApplicationStatus } from '../../../database/entities/service-application.entity';

export class CreateServiceApplicationDto {
  @IsString()
  serviceKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  requestedPermissionKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

export class ListServiceApplicationsQueryDto {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: ServiceApplicationStatus;
}

export class ApproveServiceApplicationDto {
  @IsUUID()
  targetPermissionDefinitionId!: string;

  @IsOptional()
  @IsUUID()
  reviewerAccountId?: string;
}

export class RejectServiceApplicationDto {
  @IsOptional()
  @IsUUID()
  reviewerAccountId?: string;
}
