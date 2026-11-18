import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { join } from 'node:path';
import { PublicPage, PublicSiteService } from './public-site.service';

const PUBLIC_DIRECTORY = join(__dirname, '..', '..', 'public');
const BRAND_ASSETS = new Set([
  'auth-logo-1024.png',
  'auth-logo-128.png',
  'favicon-32.png',
  'apple-touch-icon.png',
]);

@Controller()
export class PublicSiteController {
  constructor(private readonly site: PublicSiteService) {}

  @Get('about')
  about(@Res() response: Response) {
    return this.page('about', response);
  }

  @Get('privacy')
  privacy(@Res() response: Response) {
    return this.page('privacy', response);
  }

  @Get('terms')
  terms(@Res() response: Response) {
    return this.page('terms', response);
  }

  @Get('contact')
  contact(@Res() response: Response) {
    return this.page('contact', response);
  }

  @Get('public/assets/site.css')
  stylesheet(@Res() response: Response) {
    this.assetHeaders(response);
    return response
      .type('text/css')
      .sendFile(join(PUBLIC_DIRECTORY, 'public-site.css'));
  }

  @Get('brand/:asset')
  brand(@Param('asset') asset: string, @Res() response: Response) {
    if (!BRAND_ASSETS.has(asset)) throw new NotFoundException();
    this.assetHeaders(response);
    return response
      .type('image/png')
      .sendFile(join(PUBLIC_DIRECTORY, 'brand', asset));
  }

  private page(page: PublicPage, response: Response) {
    response.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    });
    return response.type('html').send(this.site.render(page));
  }

  private assetHeaders(response: Response): void {
    response.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
  }
}
