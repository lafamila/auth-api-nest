import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { lockAccountLifecycle } from '../common/crypto/account-write-lock';
import { SocialIdentityEntity } from '../database/entities/social-identity.entity';
import { SocialLoginTransactionEntity } from '../database/entities/social-login-transaction.entity';
import { ProviderRevocationsService } from '../social/provider-revocations.service';
import { privacyRetentionSettings } from './privacy-retention.settings';

@Injectable()
export class PrivacyRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrivacyRetentionService.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly revocations: ProviderRevocationsService,
  ) {}

  onModuleInit() {
    privacyRetentionSettings(this.config);
    if (this.config.get('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.processOnce().catch(() =>
        this.logger.error('Auth privacy retention cleanup failed'),
      );
    }, 60_000);
    this.timer.unref();
    void this.processOnce().catch(() =>
      this.logger.error('Auth privacy retention cleanup failed'),
    );
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.active?.catch(() => undefined);
  }
  processOnce(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.cleanup().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  private async cleanup() {
    const retention = privacyRetentionSettings(this.config);
    await this.dataSource.transaction(async (manager) => {
      const locked = await manager.query<Array<{ locked: boolean }>>(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
        ['auth:privacy-retention'],
      );
      if (!locked[0]?.locked) return;
      await lockAccountLifecycle(manager);
      const expired = await manager
        .getRepository(SocialLoginTransactionEntity)
        .createQueryBuilder('tx')
        .where('tx.expiresAt <= :now', { now: new Date() })
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(50)
        .getMany();
      for (const tx of expired) {
        const profile = tx.data.profile;
        if (profile?.encryptedRevocationGrant) {
          const registered = await manager.exists(SocialIdentityEntity, {
            where: {
              provider: profile.provider,
              providerClientId: profile.providerClientId,
              subject: profile.subject,
            },
          });
          if (!registered) {
            const target = Object.assign(new SocialIdentityEntity(), {
              provider: profile.provider,
              providerClientId: profile.providerClientId,
              subject: profile.subject,
              encryptedRevocationGrant: profile.encryptedRevocationGrant,
            });
            let usable = false;
            try {
              this.revocations.prepare([target]);
              usable = true;
            } catch {
              this.logger.warn(
                'Expired incomplete social signup needs provider-side disconnection',
              );
            }
            // Persistence failures must roll back, not silently lose a usable grant.
            if (usable)
              await this.revocations.enqueue(manager, [target], 'unlink');
          }
        }
        await manager.delete(SocialLoginTransactionEntity, tx.id);
      }
      await manager.query(
        `DELETE FROM social_login_transactions WHERE created_at <= now() - ($1::int * interval '1 hour') AND data_json->'profile'->>'encryptedRevocationGrant' IS NULL`,
        [retention.authDataRetentionHours],
      );
      await manager.query(
        `DELETE FROM email_verifications WHERE created_at <= now() - ($1::int * interval '1 hour') AND expires_at <= now()`,
        [retention.authDataRetentionHours],
      );
      await manager.query(
        `DELETE FROM admin_bootstrap_challenges WHERE created_at <= now() - ($1::int * interval '1 hour') AND expires_at <= now()`,
        [retention.authDataRetentionHours],
      );
      await manager.query(
        'DELETE FROM token_records WHERE expires_at <= now()',
      );
      await manager.query(
        `DELETE FROM audit_logs WHERE created_at <= now() - ($1::int * interval '1 day')`,
        [retention.auditRetentionDays],
      );
    });
  }
}
