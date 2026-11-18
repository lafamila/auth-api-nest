import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { PublicSiteService } from '../public-site/public-site.service';
import { privatePageHeaders } from '../portal/portal-pages';

@Controller()
export class SignupPageController {
  constructor(private readonly publicSite: PublicSiteService) {}
  @Get('signup')
  signup(@Res() response: Response) {
    const html = this.publicSite.decorate(
      readFileSync(join(process.cwd(), 'public', 'signup.html'), 'utf8'),
      'form',
    );
    response.set(privatePageHeaders(html));
    return response.type('html').send(html);
  }
}
