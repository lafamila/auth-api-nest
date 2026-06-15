import { IsEmail, IsString, MinLength } from 'class-validator';

export class BootstrapStartDto {
  @IsString()
  loginId!: string;

  @IsString()
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

export class BootstrapCompleteDto {
  @IsString()
  challengeId!: string;

  @IsString()
  otpCode!: string;
}

export class AdminLoginDto {
  @IsString()
  loginId!: string;

  @IsString()
  password!: string;

  @IsString()
  otpCode!: string;
}
