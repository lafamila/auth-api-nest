import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ProviderRevocationsModule } from '../social/provider-revocations.module';
import { PrivacyRetentionService } from './privacy-retention.service';

@Module({
  imports: [ConfigModule, ProviderRevocationsModule],
  providers: [PrivacyRetentionService],
  exports: [PrivacyRetentionService],
})
export class PrivacyRetentionModule {}
