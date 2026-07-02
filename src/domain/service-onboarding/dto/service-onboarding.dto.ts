import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OidcClientType } from '../../../database/entities/oidc-client.entity';
import {
  SERVICE_CREDENTIAL_SCOPE_KEYS,
  ServiceCredentialScope,
} from '../../../database/entities/service-credential.entity';
import { ServiceOnboardingRequestStatus } from '../../../database/entities/service-onboarding-request.entity';

export class OnboardingPermissionDto {
  @IsString()
  key!: string;

  @IsString()
  label!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class OnboardingOidcClientDto {
  @IsString()
  clientId!: string;

  @IsIn(['public', 'confidential'])
  clientType!: OidcClientType;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  redirectUris!: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  postLogoutRedirectUris?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedScopes?: string[];

  @IsOptional()
  @IsBoolean()
  requirePkce?: boolean;
}

export class OnboardingCredentialDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @IsIn(SERVICE_CREDENTIAL_SCOPE_KEYS, { each: true })
  scopes!: ServiceCredentialScope[];
}

export class CreateServiceOnboardingRequestDto {
  @IsString()
  serviceKey!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  requesterName?: string;

  @IsOptional()
  @IsEmail()
  requesterEmail?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OnboardingPermissionDto)
  permissions!: OnboardingPermissionDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OnboardingOidcClientDto)
  oidcClients?: OnboardingOidcClientDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OnboardingCredentialDto)
  serviceCredentials?: OnboardingCredentialDto[];
}

export class UpdateServiceOnboardingRequestDto extends CreateServiceOnboardingRequestDto {
  @IsOptional()
  @IsString()
  requestSecret?: string;
}

export class RejectServiceOnboardingRequestDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ListServiceOnboardingRequestsDto {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'superseded'])
  status?: ServiceOnboardingRequestStatus;
}
