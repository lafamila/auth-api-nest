import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type EventProvider = 'naver' | 'kakao' | 'google';

@Entity('provider_events')
@Index('uq_provider_event_dedup', ['provider', 'dedupHash'], { unique: true })
@Index('idx_provider_event_due', ['nextAttemptAt', 'leaseUntil'])
@Index('idx_provider_event_expiry', ['expiresAt'])
export class ProviderEventEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16 })
  provider!: EventProvider;

  @Column({ name: 'dedup_hash', type: 'varchar', length: 64 })
  dedupHash!: string;

  @Column({ name: 'encrypted_target', type: 'text', nullable: true })
  encryptedTarget!: string | null;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt!: Date;

  @Column({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken!: string | null;

  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil!: Date | null;
}
