import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdminAuthService } from './admin/admin-auth.service';
import { SERVICE_CREDENTIAL_SCOPE_DEFINITIONS } from './database/entities/service-credential.entity';
import { privatePageHeaders } from './portal/portal-pages';
import { PublicSiteService } from './public-site/public-site.service';

@Controller()
export class ServicePageController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly publicSite?: PublicSiteService,
  ) {}

  @Get('service')
  async service(@Req() request: Request, @Res() response: Response) {
    await this.validateAdminRequest(request);
    const source = readFileSync(
      join(process.cwd(), 'public', 'service.html'),
      'utf8',
    );
    const html = this.publicSite?.decorate(source, 'application') ?? source;
    response.set(privatePageHeaders(html));
    return response.type('html').send(html);
  }

  @Get('service-request-import.js')
  async serviceRequestImport(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.validateAdminRequest(request);
    response.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return response.sendFile(
      join(process.cwd(), 'public', 'service-request-import.js'),
    );
  }

  @Get('api/service-credential-scopes')
  serviceCredentialScopes() {
    return SERVICE_CREDENTIAL_SCOPE_DEFINITIONS;
  }

  private async validateAdminRequest(request: Request): Promise<void> {
    try {
      await this.adminAuth.validateRequest(request);
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      )
        throw new NotFoundException();
      throw error;
    }
  }
}
