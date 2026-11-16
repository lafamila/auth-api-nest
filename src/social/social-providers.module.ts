import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { SocialProvidersService } from './social-providers.service';

@Module({
  imports: [AppConfigModule],
  providers: [SocialProvidersService],
  exports: [SocialProvidersService],
})
export class SocialProvidersModule {}
