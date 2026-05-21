import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogEntity } from '../../database/entities/audit-log.entity';

export interface AuditInput {
  actorAccountId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  beforeJson?: Record<string, unknown> | null;
  afterJson?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditLogsService {
  constructor(
    @InjectRepository(AuditLogEntity)
    private readonly auditLogs: Repository<AuditLogEntity>,
  ) {}

  async record(input: AuditInput): Promise<AuditLogEntity> {
    return this.auditLogs.save(
      this.auditLogs.create({
        actorAccountId: input.actorAccountId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        beforeJson: input.beforeJson ?? null,
        afterJson: input.afterJson ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      }),
    );
  }

  list(limit = 100): Promise<AuditLogEntity[]> {
    return this.auditLogs.find({
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 500),
    });
  }
}
