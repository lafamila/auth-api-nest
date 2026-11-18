import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminSessionModule } from '../admin/admin-session.module';
import { AppConfigModule } from '../config/app-config.module';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { AuthSessionModule } from '../oidc/auth-session.module';
import { SignupModule } from '../signup/signup.module';
import { SocialProvidersModule } from '../social/social-providers.module';
import { PortalAuthService } from './portal-auth.service';
import { PortalProfileService } from './portal-profile.service';
import { PortalSessionService } from './portal-session.service';
import { PublicSiteModule } from '../public-site/public-site.module';
import { AccountPoliciesModule } from '../policies/account-policies.module';
import { AccountLifecycleModule } from './account-lifecycle.module';

@Module({
  imports: [
    AdminSessionModule,
    AppConfigModule,
    AccountsModule,
    AuthSessionModule,
    SignupModule,
    SocialProvidersModule,
    PublicSiteModule,
    AccountPoliciesModule,
    AccountLifecycleModule,
    TypeOrmModule.forFeature([TokenRecordEntity]),
  ],
  providers: [PortalAuthService, PortalProfileService, PortalSessionService],
  exports: [PortalAuthService, PortalProfileService, PortalSessionService],
})
export class PortalModule {}
