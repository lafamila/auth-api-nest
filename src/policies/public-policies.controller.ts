import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { AccountPoliciesService } from './account-policies.service';

@Controller('api/public/policies')
export class PublicPoliciesController {
  constructor(private readonly policies: AccountPoliciesService) {}
  @Get() current(@Res({ passthrough: true }) response: Response) {
    response.set('Cache-Control', 'no-store');
    return this.policies.current();
  }
}
