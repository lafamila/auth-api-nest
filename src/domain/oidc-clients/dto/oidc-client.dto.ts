import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
} from 'class-validator';
import {
  OidcClientStatus,
  OidcClientType,
} from '../../../database/entities/oidc-client.entity';

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
  @IsUrl({ require_tld: false }, { each: true })
  redirectUris!: string[];

  @IsOptional()
  @IsArray()
  @IsUrl({ require_tld: false }, { each: true })
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
}

export class UpdateOidcClientDto {
  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: OidcClientStatus;

  @IsOptional()
  @IsArray()
  @IsUrl({ require_tld: false }, { each: true })
  redirectUris?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedScopes?: string[];
}

export class RotateClientSecretDto {
  @IsString()
  @MinLength(16)
  clientSecret!: string;
}
