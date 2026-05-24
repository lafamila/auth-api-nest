import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'node:path';
import { AccountServicePermissionEntity } from './entities/account-service-permission.entity';
import { AccountEntity } from './entities/account.entity';
import { AuditLogEntity } from './entities/audit-log.entity';
import { OidcClientEntity } from './entities/oidc-client.entity';
import { ServicePermissionDefinitionEntity } from './entities/service-permission-definition.entity';
import { ServiceApplicationEntity } from './entities/service-application.entity';
import { ServiceCredentialEntity } from './entities/service-credential.entity';
import { ServiceEntity } from './entities/service.entity';
import { SigningKeyEntity } from './entities/signing-key.entity';
import { TokenRecordEntity } from './entities/token-record.entity';
import { AppConfigModule } from '../config/app-config.module';
import { AppConfigService } from '../config/app-config.service';

export const AUTH_ENTITIES = [
  AccountEntity,
  ServiceEntity,
  OidcClientEntity,
  ServicePermissionDefinitionEntity,
  AccountServicePermissionEntity,
  ServiceApplicationEntity,
  ServiceCredentialEntity,
  AuditLogEntity,
  TokenRecordEntity,
  SigningKeyEntity,
];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        type: 'postgres',
        url: config.databaseUrl,
        entities: AUTH_ENTITIES,
        synchronize: config.nodeEnv === 'test',
        migrations: [join(__dirname, 'migrations/*{.ts,.js}')],
        migrationsRun: config.runMigrations,
        ssl: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
