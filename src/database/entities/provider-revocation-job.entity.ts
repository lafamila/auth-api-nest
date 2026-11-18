import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ProviderRevocationStatus =
  | 'pending'
  | 'processing'
  | 'retry'
  | 'succeeded'
  | 'manual_required';
export type ProviderRevocationReason = 'unlink' | 'withdraw';

// No account/identity FK: the encrypted target must survive account deletion.
@Entity('provider_revocation_jobs')
@Index(['status', 'nextAttemptAt'])
@Index(['targetHash', 'status'])
export class ProviderRevocationJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 24 })
  reason!: ProviderRevocationReason;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  status!: ProviderRevocationStatus;

  @Column({ name: 'target_hash', type: 'varchar', length: 64, select: false })
  targetHash!: string;

  @Column({
    name: 'encrypted_payload',
    type: 'text',
    nullable: true,
    select: false,
  })
  encryptedPayload!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'deadline_at', type: 'timestamptz' })
  deadlineAt!: Date;

  @Column({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken!: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  lastErrorCode!: string | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
