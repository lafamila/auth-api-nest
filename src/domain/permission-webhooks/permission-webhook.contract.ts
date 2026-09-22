import { createHmac, randomUUID } from 'node:crypto';
import { PermissionWebhookEventType } from '../../database/entities/permission-webhook-subscription.entity';

export type PermissionUpdateReason = 'approved' | 'changed' | 'revoked';

export interface PermissionUpdatedWebhookEvent {
  id: string;
  type: 'permission.updated';
  occurredAt: string;
  serviceKey: string;
  accountId: string;
  data: {
    permission: string | null;
    previousPermission: string | null;
    status: 'active' | 'revoked';
    reason: PermissionUpdateReason;
  };
}

export interface ServiceApplicationRejectedWebhookEvent {
  id: string;
  type: 'service_application.rejected';
  occurredAt: string;
  serviceKey: string;
  accountId: string;
  data: {
    applicationId: string;
    status: 'rejected';
    requestedPermission: string | null;
  };
}

export type PermissionWebhookEvent =
  | PermissionUpdatedWebhookEvent
  | ServiceApplicationRejectedWebhookEvent;

export function createPermissionWebhookEvent<T extends PermissionWebhookEvent>(
  event: Omit<T, 'id' | 'occurredAt'>,
): T {
  return {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    ...event,
  } as T;
}

export function signPermissionWebhook(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `v1=${digest}`;
}

export function permissionWebhookRetryDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(attempt - 1, 0), 5 * 60_000);
}

export function isPermissionWebhookEventType(
  value: string,
): value is PermissionWebhookEventType {
  return (
    value === 'permission.updated' || value === 'service_application.rejected'
  );
}
