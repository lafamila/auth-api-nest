import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import {
  OidcClientStatus,
  OidcClientType,
} from '../../../database/entities/oidc-client.entity';
import { IsRedirectUri } from '../redirect-uri.validator';

export class CreateOidcClientDto {
  @IsString()
  clientId!: string;

  @IsIn(['public', 'confidential'])
  clientType!: OidcClientType;

  @IsOptional()
  @IsString()
  @MinLength(16)
  clientSecret?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsRedirectUri({ each: true })
  redirectUris!: string[];

  @IsOptional()
  @IsArray()
  @IsRedirectUri({ each: true })
  postLogoutRedirectUris?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedGrantTypes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedScopes?: string[];

  @IsOptional()
  @IsBoolean()
  requirePkce?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  accessTokenTtlSeconds?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  refreshTokenTtlSeconds?: number | null;
}

export class UpdateOidcClientDto {
  @IsOptional()
  @IsIn(['public', 'confidential'])
  clientType?: OidcClientType;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: OidcClientStatus;

  @IsOptional()
  @IsArray()
  @IsRedirectUri({ each: true })
  redirectUris?: string[];

  @IsOptional()
  @IsArray()
  @IsRedirectUri({ each: true })
  postLogoutRedirectUris?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedGrantTypes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedScopes?: string[];

  @IsOptional()
  @IsBoolean()
  requirePkce?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  accessTokenTtlSeconds?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  refreshTokenTtlSeconds?: number | null;

  @IsOptional()
  @IsString()
  @MinLength(16)
  clientSecret?: string;
}

export class RotateClientSecretDto {
  @IsString()
  @MinLength(16)
  clientSecret!: string;
}

export interface OidcClientView {
  id: string;
  serviceId: string;
  clientId: string;
  clientType: OidcClientType;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  allowedGrantTypes: string[];
  allowedScopes: string[];
  requirePkce: boolean;
  accessTokenTtlSeconds: number | null;
  refreshTokenTtlSeconds: number | null;
  status: OidcClientStatus;
  createdAt: Date;
  updatedAt: Date;
}
