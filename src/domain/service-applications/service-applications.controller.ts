import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../admin/admin.guard';
import { TokenService } from '../../oidc/token.service';
import {
  ApproveServiceApplicationDto,
  CreateServiceApplicationDto,
  ListServiceApplicationsQueryDto,
  RejectServiceApplicationDto,
} from './dto/service-application.dto';
import {
  ServiceAccessTokenClaims,
  ServiceApplicationsService,
} from './service-applications.service';

@Controller()
export class ServiceApplicationsController {
  constructor(
    private readonly applications: ServiceApplicationsService,
    private readonly tokens: TokenService,
  ) {}

  @Post('api/service-applications')
  create(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: CreateServiceApplicationDto,
  ) {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    if (!token) {
      throw new UnauthorizedException('Bearer access token is required');
    }
    const claims = this.tokens.verifyAccessToken(token) as ServiceAccessTokenClaims;
    return this.applications.createFromVisitorToken(claims, body);
  }

  @UseGuards(AdminGuard)
  @Get('api/admin/service-applications')
  list(@Query() query: ListServiceApplicationsQueryDto) {
    return this.applications.list(query.status);
  }

  @UseGuards(AdminGuard)
  @Post('api/admin/service-applications/:applicationId/approve')
  approve(
    @Param('applicationId') applicationId: string,
    @Body() body: ApproveServiceApplicationDto,
  ) {
    return this.applications.approve(
      applicationId,
      body.targetPermissionDefinitionId,
      body.reviewerAccountId,
    );
  }

  @UseGuards(AdminGuard)
  @Post('api/admin/service-applications/:applicationId/reject')
  reject(
    @Param('applicationId') applicationId: string,
    @Body() body: RejectServiceApplicationDto,
  ) {
    return this.applications.reject(applicationId, body.reviewerAccountId);
  }
}
