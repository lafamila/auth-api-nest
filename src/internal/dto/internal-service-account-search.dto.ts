import { IsOptional, IsString } from 'class-validator';

export class InternalServiceAccountSearchQueryDto {
  @IsString()
  serviceKey!: string;

  @IsOptional()
  @IsString()
  q?: string;
}
