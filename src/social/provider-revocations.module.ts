import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import { AppConfigModule } from '../config/app-config.module';
import { ProviderRevocationJobEntity } from '../database/entities/provider-revocation-job.entity';
import { ProviderRevocationsClient } from './provider-revocations.client';
import { ProviderRevocationsService } from './provider-revocations.service';

@Module({
  imports: [
    AppConfigModule,
    ConfigModule,
    TypeOrmModule.forFeature([ProviderRevocationJobEntity]),
  ],
  providers: [
    AesGcmService,
    ProviderRevocationsClient,
    ProviderRevocationsService,
  ],
  exports: [ProviderRevocationsService],
})
export class ProviderRevocationsModule {}
