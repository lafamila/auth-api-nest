import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import { TotpService } from '../common/crypto/totp.service';
import { AppConfigModule } from '../config/app-config.module';
import { AdminBootstrapChallengeEntity } from '../database/entities/admin-bootstrap-challenge.entity';
import { AdminMfaEntity } from '../database/entities/admin-mfa.entity';
import { AdminSessionEntity } from '../database/entities/admin-session.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { AuditLogsModule } from '../domain/audit-logs/audit-logs.module';
import { AdminAuthService } from './admin-auth.service';
import { AdminGuard } from './admin.guard';
import { AdminMfaThrottleService } from './admin-mfa-throttle.service';

@Module({
  imports: [
    AppConfigModule,
    AccountsModule,
    AuditLogsModule,
    TypeOrmModule.forFeature([
      AdminBootstrapChallengeEntity,
      AdminMfaEntity,
      AdminSessionEntity,
      TokenRecordEntity,
    ]),
  ],
  providers: [
    AdminAuthService,
    AdminGuard,
    AdminMfaThrottleService,
    AesGcmService,
    TotpService,
  ],
  exports: [AdminAuthService, AdminGuard, AdminMfaThrottleService],
})
export class AdminSessionModule {}
