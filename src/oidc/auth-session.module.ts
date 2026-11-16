import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from '../config/app-config.module';
import { AccountEntity } from '../database/entities/account.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { SsoSessionService } from './sso-session.service';

@Module({
  imports: [
    AppConfigModule,
    AccountsModule,
    TypeOrmModule.forFeature([AccountEntity, TokenRecordEntity]),
  ],
  providers: [SsoSessionService],
  exports: [SsoSessionService],
})
export class AuthSessionModule {}
