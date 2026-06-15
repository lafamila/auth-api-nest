import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { join } from 'node:path';

@Controller()
export class SignupPageController {
  @Get('signup')
  signup(@Res() response: Response) {
    return response.sendFile(join(process.cwd(), 'public', 'signup.html'));
  }
}
