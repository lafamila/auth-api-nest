import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailVerificationEntity } from '../database/entities/email-verification.entity';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { AppConfigModule } from '../config/app-config.module';
import { EmailDeliveryService } from './email-delivery.service';
import { SignupController } from './signup.controller';
import { SignupPageController } from './signup-page.controller';
import { SignupService } from './signup.service';
import { AccountPoliciesModule } from '../policies/account-policies.module';
import { PublicSiteModule } from '../public-site/public-site.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EmailVerificationEntity]),
    AccountsModule,
    AppConfigModule,
    AccountPoliciesModule,
    PublicSiteModule,
  ],
  controllers: [SignupController, SignupPageController],
  providers: [SignupService, EmailDeliveryService],
  exports: [EmailDeliveryService],
})
export class SignupModule {}
