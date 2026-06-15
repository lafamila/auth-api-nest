import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailVerificationEntity } from '../database/entities/email-verification.entity';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { AppConfigModule } from '../config/app-config.module';
import { EmailDeliveryService } from './email-delivery.service';
import { SignupController } from './signup.controller';
import { SignupPageController } from './signup-page.controller';
import { SignupService } from './signup.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([EmailVerificationEntity]),
    AccountsModule,
    AppConfigModule,
  ],
  controllers: [SignupController, SignupPageController],
  providers: [SignupService, EmailDeliveryService],
})
export class SignupModule {}
