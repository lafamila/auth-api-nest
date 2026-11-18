import { IsEmail, IsString, MinLength } from 'class-validator';
import { PolicyAcceptanceDto } from '../../policies/policy-acceptance.dto';

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

export class SignupCompleteDto extends PolicyAcceptanceDto {
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
