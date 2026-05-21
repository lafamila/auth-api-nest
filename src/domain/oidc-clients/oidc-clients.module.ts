import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { OidcClientEntity } from '../../database/entities/oidc-client.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ServiceRegistryModule } from '../service-registry/service-registry.module';
import { OidcClientsService } from './oidc-clients.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([OidcClientEntity]),
    ServiceRegistryModule,
    AuditLogsModule,
  ],
  providers: [OidcClientsService, PasswordService],
  exports: [OidcClientsService],
})
export class OidcClientsModule {}
