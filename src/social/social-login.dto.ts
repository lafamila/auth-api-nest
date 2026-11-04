import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

export class SocialStartDto {
  @IsString()
  @Length(1, 128)
  login_transaction!: string;
}

export class SocialTransactionDto {
  @IsString()
  @Length(1, 128)
  transaction!: string;
}

export class SocialEmailStartDto extends SocialTransactionDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class SocialEmailVerifyDto extends SocialTransactionDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class SocialCompleteDto extends SocialEmailStartDto {
  @IsString()
  @Length(1, 255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  loginId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  passwordConfirm?: string;
}
