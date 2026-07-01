import { Body, Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import {
  SignupCompleteDto,
  SignupLoginIdCheckDto,
  SignupStartDto,
  SignupVerifyCodeDto,
} from './dto/signup.dto';
import { SignupService } from './signup.service';

@Controller('api/signup')
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  @Post('check-login-id')
  checkLoginId(@Body() body: SignupLoginIdCheckDto) {
    return this.signup.checkLoginId(body);
  }

  @Post('start')
  start(@Body() body: SignupStartDto, @Req() request: Request) {
    return this.signup.start(body, this.ipAddress(request));
  }

  @Post('verify-code')
  verifyCode(@Body() body: SignupVerifyCodeDto) {
    return this.signup.verifyCode(body);
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
