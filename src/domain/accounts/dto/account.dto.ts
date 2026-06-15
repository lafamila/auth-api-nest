import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { AccountStatus } from '../../../database/entities/account.entity';

export class CreateAccountDto {
  @IsString()
  loginId!: string;

  @IsString()
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsBoolean()
  isSuperAdmin?: boolean;
}

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsIn(['active', 'locked', 'disabled'])
  status?: AccountStatus;
}

export class ResetPasswordDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

export class CompletePasswordResetDto {
  @IsString()
  loginId!: string;

  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}
