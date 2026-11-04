import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { AccountPermissionsModule } from '../domain/account-permissions/account-permissions.module';
import { AppConfigModule } from '../config/app-config.module';
import { OidcClientsModule } from '../domain/oidc-clients/oidc-clients.module';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import { SigningKeyEntity } from '../database/entities/signing-key.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { OidcController } from './oidc.controller';
import { LoginController } from './login.controller';
import { AuthorizationCodeService } from './authorization-code.service';
import { AuthorizeFlowService } from './authorize-flow.service';
import { OidcProviderAdapterService } from './oidc-provider-adapter.service';
import { SigningKeyService } from './signing-key.service';
import { TokenService } from './token.service';
import { HostedLoginTransactionService } from './hosted-login-transaction.service';
import { SocialLoginController } from '../social/social-login.controller';
import { SocialLoginService } from '../social/social-login.service';
import { SocialProvidersService } from '../social/social-providers.service';
import { SocialIdentityEntity } from '../database/entities/social-identity.entity';
import { SocialLoginTransactionEntity } from '../database/entities/social-login-transaction.entity';
import { EmailVerificationEntity } from '../database/entities/email-verification.entity';
import { SignupModule } from '../signup/signup.module';
import { AuditLogsModule } from '../domain/audit-logs/audit-logs.module';

@Module({
  imports: [
    AppConfigModule,
    AccountsModule,
    OidcClientsModule,
    AccountPermissionsModule,
    SignupModule,
    AuditLogsModule,
    TypeOrmModule.forFeature([
      TokenRecordEntity,
      SigningKeyEntity,
      SocialIdentityEntity,
      SocialLoginTransactionEntity,
      EmailVerificationEntity,
    ]),
  ],
  controllers: [OidcController, LoginController, SocialLoginController],
  providers: [
    AuthorizationCodeService,
    AuthorizeFlowService,
    OidcProviderAdapterService,
    AesGcmService,
    SigningKeyService,
    TokenService,
    HostedLoginTransactionService,
    SocialLoginService,
    SocialProvidersService,
  ],
  exports: [TokenService, SigningKeyService],
})
export class OidcModule {}
