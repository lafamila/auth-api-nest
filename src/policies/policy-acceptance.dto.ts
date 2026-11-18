import { Equals, IsString, Length, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class PolicyAcceptanceDto {
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
}
