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
import { SocialProvidersModule } from '../social/social-providers.module';
import { SocialIdentityEntity } from '../database/entities/social-identity.entity';
import { SocialLoginTransactionEntity } from '../database/entities/social-login-transaction.entity';
import { EmailVerificationEntity } from '../database/entities/email-verification.entity';
import { SignupModule } from '../signup/signup.module';
import { AuditLogsModule } from '../domain/audit-logs/audit-logs.module';
import { AuthSessionModule } from './auth-session.module';
import { PortalModule } from '../portal/portal.module';
import { PortalController } from '../portal/portal.controller';
import { AdminSessionModule } from '../admin/admin-session.module';
import { AccountPoliciesModule } from '../policies/account-policies.module';
import { PublicSiteModule } from '../public-site/public-site.module';
import { AccountLifecycleModule } from '../portal/account-lifecycle.module';
import { ProviderRevocationsModule } from '../social/provider-revocations.module';

@Module({
  imports: [
    AppConfigModule,
    AccountsModule,
    OidcClientsModule,
    AccountPermissionsModule,
    SignupModule,
    AuditLogsModule,
    AuthSessionModule,
    PortalModule,
    SocialProvidersModule,
    AdminSessionModule,
    AccountPoliciesModule,
    PublicSiteModule,
    AccountLifecycleModule,
    ProviderRevocationsModule,
    TypeOrmModule.forFeature([
      TokenRecordEntity,
      SigningKeyEntity,
      SocialIdentityEntity,
      SocialLoginTransactionEntity,
      EmailVerificationEntity,
    ]),
  ],
  controllers: [
    OidcController,
    LoginController,
    SocialLoginController,
    PortalController,
  ],
  providers: [
    AuthorizationCodeService,
    AuthorizeFlowService,
    OidcProviderAdapterService,
    AesGcmService,
    SigningKeyService,
    TokenService,
    HostedLoginTransactionService,
    SocialLoginService,
  ],
  exports: [TokenService, SigningKeyService],
})
export class OidcModule {}
