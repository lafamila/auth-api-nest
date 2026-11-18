import { Module } from '@nestjs/common';
import { AesGcmService } from '../common/crypto/aes-gcm.service';
import { AppConfigModule } from '../config/app-config.module';
import { SocialProvidersService } from './social-providers.service';

@Module({
  imports: [AppConfigModule],
  providers: [AesGcmService, SocialProvidersService],
  exports: [SocialProvidersService],
})
export class SocialProvidersModule {}
