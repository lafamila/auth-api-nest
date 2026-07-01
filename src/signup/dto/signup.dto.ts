import { IsEmail, IsString, MinLength } from 'class-validator';

export class SignupLoginIdCheckDto {
  @IsString()
  loginId!: string;
}

export class SignupStartDto {
  @IsEmail()
  email!: string;
}

export class SignupVerifyCodeDto {
  @IsEmail()
  email!: string;

  @IsString()
  code!: string;
}

export class SignupCompleteDto {
  @IsString()
  loginId!: string;

  @IsString()
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  code!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
