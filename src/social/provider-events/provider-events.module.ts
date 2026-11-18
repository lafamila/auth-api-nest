import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { text } from 'express';
import { AesGcmService } from '../../common/crypto/aes-gcm.service';
import { AppConfigModule } from '../../config/app-config.module';
import { AccountLifecycleModule } from '../../portal/account-lifecycle.module';
import { GoogleEventsVerifier } from './google-events.verifier';
import { ProviderEventsController } from './provider-events.controller';
import { ProviderEventsService } from './provider-events.service';
import { ProviderEventsVerifier } from './provider-events.verifier';

@Module({
  imports: [AppConfigModule, ConfigModule, AccountLifecycleModule],
  controllers: [ProviderEventsController],
  providers: [
    AesGcmService,
    ProviderEventsService,
    ProviderEventsVerifier,
    GoogleEventsVerifier,
  ],
  exports: [ProviderEventsService],
})
export class ProviderEventsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(text({ type: 'application/secevent+jwt', limit: '64kb' }))
      .forRoutes({ path: 'oauth/events/google', method: RequestMethod.POST });
  }
}
