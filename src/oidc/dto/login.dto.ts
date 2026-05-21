import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  loginId!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
