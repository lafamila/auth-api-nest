import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import { AuditLogsService } from '../../domain/audit-logs/audit-logs.service';

@UseGuards(AdminGuard)
@Controller('api/admin/audit-logs')
export class AdminAuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    return this.auditLogs.list(limit ? Number(limit) : 100);
  }
}
