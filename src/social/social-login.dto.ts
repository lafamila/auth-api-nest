import { Equals, IsEmail, IsString, Length, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

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
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value,
  )
  @Equals(true)
  termsAccepted!: true;
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value,
  )
  @Equals(true)
  privacyAccepted!: true;
  @IsString() @MaxLength(64) termsVersion!: string;
  @IsString() @MaxLength(64) privacyVersion!: string;
  @IsString() @Length(64, 64) policyDigest!: string;
  @IsString()
  @Length(1, 255)
  name!: string;
}
