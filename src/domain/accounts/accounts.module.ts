import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { AppConfigModule } from '../../config/app-config.module';
import { AccountEntity } from '../../database/entities/account.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AccountsService } from './accounts.service';
import { SeedService } from './seed.service';

@Module({
  imports: [AppConfigModule, TypeOrmModule.forFeature([AccountEntity]), AuditLogsModule],
  providers: [AccountsService, PasswordService, SeedService],
  exports: [AccountsService, PasswordService],
})
export class AccountsModule {}
