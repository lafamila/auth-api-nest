import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsUUID,
  Matches,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { AccountEntity } from '../database/entities/account.entity';

export class PortalEmailStartDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  currentPassword!: string;
}

export class PortalEmailCompleteDto {
  @IsUUID()
  verificationId!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9]{6}$/)
  code!: string;
}

export class PortalPasswordDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  loginId?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  currentPassword?: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(8)
  passwordConfirm!: string;
}

export type PortalAccountDto = Pick<
  AccountEntity,
  | 'id'
  | 'loginId'
  | 'name'
  | 'email'
  | 'status'
  | 'isSuperAdmin'
  | 'passwordResetRequired'
  | 'emailVerifiedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'lastLoginAt'
> & { hasLocalCredentials: boolean };

export interface PortalOverviewDto {
  account: PortalAccountDto;
  services: Array<{
    id: string;
    key: string;
    name: string;
    description: string;
    permission: { key: string; label: string };
    grantedAt: Date;
  }>;
  socialProviders: Array<{
    key: string;
    label: string;
    linked: boolean;
    enabled: boolean;
    linkedAt: Date | null;
  }>;
  csrfToken: string;
}

export interface PortalEmailStartResult {
  verificationId: string;
  email: string;
  expiresAt: Date;
}

export interface PortalReauthenticateResult {
  reauthenticate: true;
}
