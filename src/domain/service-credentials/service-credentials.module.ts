import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { ServiceCredentialEntity } from '../../database/entities/service-credential.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ServiceRegistryModule } from '../service-registry/service-registry.module';
import { ServiceCredentialsService } from './service-credentials.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ServiceCredentialEntity]),
    ServiceRegistryModule,
    AuditLogsModule,
  ],
  providers: [ServiceCredentialsService, PasswordService],
  exports: [ServiceCredentialsService],
})
export class ServiceCredentialsModule {}
