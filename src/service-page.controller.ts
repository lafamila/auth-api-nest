import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { join } from 'node:path';

@Controller()
export class ServicePageController {
  @Get('admin')
  admin(@Res() response: Response) {
    return response.sendFile(join(process.cwd(), 'public', 'index.html'));
  }

  @Get('service')
  service(@Res() response: Response) {
    return response.sendFile(join(process.cwd(), 'public', 'service.html'));
  }

  @Get('service-request-import.js')
  serviceRequestImport(@Res() response: Response) {
    return response.sendFile(join(process.cwd(), 'public', 'service-request-import.js'));
  }
}
