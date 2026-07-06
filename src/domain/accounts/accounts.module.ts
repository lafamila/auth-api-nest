import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { AppConfigModule } from '../../config/app-config.module';
import { AccountEntity } from '../../database/entities/account.entity';
import { TokenRecordEntity } from '../../database/entities/token-record.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AccountsService } from './accounts.service';

@Module({
  imports: [
    AppConfigModule,
    TypeOrmModule.forFeature([AccountEntity, TokenRecordEntity]),
    AuditLogsModule,
  ],
  providers: [AccountsService, PasswordService],
  exports: [AccountsService, PasswordService],
})
export class AccountsModule {}
