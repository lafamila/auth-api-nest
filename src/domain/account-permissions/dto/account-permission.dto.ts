import { IsUUID } from 'class-validator';

export class PutAccountPermissionDto {
  @IsUUID()
  permissionDefinitionId!: string;
}
