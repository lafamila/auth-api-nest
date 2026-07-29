import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  SERVICE_CREDENTIAL_SCOPE_KEYS,
  ServiceCredentialScope,
} from '../../database/entities/service-credential.entity';

export class InternalServiceCredentialVerifyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  keyId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  secret!: string;

  @IsOptional()
  @IsIn(SERVICE_CREDENTIAL_SCOPE_KEYS)
  requiredScope?: ServiceCredentialScope;
}
