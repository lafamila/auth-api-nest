import { IsOptional, IsString, MinLength } from 'class-validator';

export class HostedLoginDto {
  @IsString()
  loginId!: string;

  @IsString()
  @MinLength(1)
  password!: string;

  @IsString()
  client_id!: string;

  @IsString()
  redirect_uri!: string;

  @IsString()
  response_type!: string;

  @IsString()
  scope!: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsString()
  code_challenge!: string;

  @IsString()
  code_challenge_method!: string;
}
