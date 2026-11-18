import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EventProvider } from '../../database/entities/provider-event.entity';

export const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_SECONDS = 60;

export interface ProviderEventTarget {
  clientId: string;
  subject: string;
  kind: 'unlinked' | 'sessions_revoked';
}

export interface ProviderEventIdentitySnapshot {
  identityId: string;
  grantDigest: string;
}

export interface QueuedProviderEventTarget extends ProviderEventTarget {
  expectedSnapshot: ProviderEventIdentitySnapshot | null;
}

export function providerEventIdentitySnapshot(identity: {
  id: string;
  encryptedRevocationGrant: string | null;
}): ProviderEventIdentitySnapshot {
  return {
    identityId: identity.id,
    grantDigest: createHash('sha256')
      .update(JSON.stringify(identity.encryptedRevocationGrant))
      .digest('hex'),
  };
}

export interface VerifiedProviderEvent {
  provider: EventProvider;
  deduplicationId: string;
  targets: ProviderEventTarget[];
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Invalid provider event');
  }
  return value as Record<string, unknown>;
}

export function field(value: unknown, maxLength = 512): string {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new BadRequestException('Invalid provider event');
  }
  return value;
}

export function assertFresh(timestamp: number): void {
  const now = Math.floor(Date.now() / 1000);
  // Reserve future clock skew inside the receipt's 24h dedup lifetime.
  const maxAgeSeconds = EVENT_TTL_MS / 1000 - CLOCK_SKEW_SECONDS;
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    timestamp > now + CLOCK_SKEW_SECONDS ||
    timestamp <= now - maxAgeSeconds
  ) {
    throw new UnauthorizedException('Invalid provider event time');
  }
}
