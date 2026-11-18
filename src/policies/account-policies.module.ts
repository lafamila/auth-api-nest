import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountPolicyConsentEntity } from '../database/entities/account-policy-consent.entity';
import { PublicSiteModule } from '../public-site/public-site.module';
import { AccountPoliciesService } from './account-policies.service';
import { PublicPoliciesController } from './public-policies.controller';

@Module({
  imports: [
    PublicSiteModule,
    TypeOrmModule.forFeature([AccountPolicyConsentEntity]),
  ],
  providers: [AccountPoliciesService],
  controllers: [PublicPoliciesController],
  exports: [AccountPoliciesService],
})
export class AccountPoliciesModule {}
