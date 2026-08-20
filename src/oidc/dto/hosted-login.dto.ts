import {
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class HostedLoginDto {
  @ValidateIf((body: HostedLoginDto) => body.account_selection !== 'current')
  @IsString()
  loginId?: string;

  @ValidateIf((body: HostedLoginDto) => body.account_selection !== 'current')
  @IsString()
  @MinLength(1)
  password?: string;

  @IsOptional()
  @IsIn(['current', 'other'])
  account_selection?: 'current' | 'other';

  @IsString()
  login_transaction!: string;
}
