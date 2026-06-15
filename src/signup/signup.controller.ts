import { Body, Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { SignupCompleteDto, SignupStartDto } from './dto/signup.dto';
import { SignupService } from './signup.service';

@Controller('api/signup')
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  @Post('start')
  start(@Body() body: SignupStartDto, @Req() request: Request) {
    return this.signup.start(body, this.ipAddress(request));
  }

  @Post('complete')
  complete(@Body() body: SignupCompleteDto) {
    return this.signup.complete(body);
  }

  private ipAddress(request: Request): string | null {
    const forwarded = request.header('x-forwarded-for')?.split(',')[0]?.trim();
    return forwarded || request.ip || null;
  }
}
