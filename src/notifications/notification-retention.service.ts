import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';

@Injectable()
export class NotificationRetentionService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationRetentionService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.purge().catch((error) => this.logError(error)),
      this.config.notificationRetentionIntervalMs,
    );
    this.timer.unref();
    void this.purge().catch((error) => this.logError(error));
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async purge(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `DELETE FROM notification_delivery_attempts WHERE created_at < now() - interval '30 days'`,
      );
      await manager.query(
        `DELETE FROM notifications
         WHERE (deleted_at IS NULL AND created_at < now() - interval '90 days')
            OR (deleted_at IS NOT NULL AND deleted_at < now() - interval '90 days')`,
      );
      await manager.query(
        `DELETE FROM notification_devices WHERE status = 'disabled' AND disabled_at < now() - interval '90 days'`,
      );
      await manager.query(
        `DELETE FROM notification_idempotency_keys WHERE expires_at <= now()`,
      );
    });
  }

  private logError(error: unknown): void {
    this.logger.error(
      `Notification retention failed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    );
  }
}
