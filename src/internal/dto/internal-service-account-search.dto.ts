import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class InternalServiceAccountSearchQueryDto {
  @IsString()
  serviceKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  q?: string;

  @IsOptional()
  @IsIn(['loginId', 'name'])
  exactMatch?: 'loginId' | 'name';
}
