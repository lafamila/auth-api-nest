import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PublicSiteController } from './public-site.controller';
import { PublicSiteService } from './public-site.service';

@Module({
  imports: [ConfigModule],
  controllers: [PublicSiteController],
  providers: [PublicSiteService],
  exports: [PublicSiteService],
})
export class PublicSiteModule {}
