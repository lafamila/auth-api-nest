import type { ConfigService } from '@nestjs/config';

export function privacyRetentionSettings(config: ConfigService) {
  const hours = Number(
    config.get<string>('AUTH_PRIVACY_AUTH_DATA_RETENTION_HOURS') ?? '1',
  );
  const days = Number(
    config.get<string>('AUTH_PRIVACY_AUDIT_RETENTION_DAYS') ?? '30',
  );
  const backupDays = Number(
    config.get<string>('AUTH_PUBLIC_BACKUP_RETENTION_DAYS') ?? '7',
  );
  if (
    !Number.isSafeInteger(hours) ||
    hours < 1 ||
    hours > 24 ||
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > 365 ||
    !Number.isSafeInteger(backupDays) ||
    backupDays < 1 ||
    backupDays > 365
  )
    throw new Error('Invalid Auth privacy retention configuration');
  return {
    authDataRetentionHours: hours,
    auditRetentionDays: days,
    backupRetentionDays: backupDays,
  };
}
