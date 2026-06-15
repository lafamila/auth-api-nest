import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ServiceOnboardingRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'superseded';

export type ServiceOnboardingRequestKind = 'create' | 'update';

@Entity('service_onboarding_requests')
export class ServiceOnboardingRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'service_key' })
  serviceKey!: string;

  @Column({ default: 'create' })
  kind!: ServiceOnboardingRequestKind;

  @Column({ default: 'pending' })
  status!: ServiceOnboardingRequestStatus;

  @Column({ default: 1 })
  revision!: number;

  @Column({ name: 'request_secret_hash' })
  requestSecretHash!: string;

  @Column({ name: 'requester_name', type: 'varchar', nullable: true })
  requesterName!: string | null;

  @Column({ name: 'requester_email', type: 'varchar', nullable: true })
  requesterEmail!: string | null;

  @Column({ name: 'requested_spec_json', type: 'jsonb' })
  requestedSpecJson!: Record<string, unknown>;

  @Column({ name: 'approved_snapshot_json', type: 'jsonb', nullable: true })
  approvedSnapshotJson!: Record<string, unknown> | null;

  @Column({ name: 'decision_reason', type: 'text', nullable: true })
  decisionReason!: string | null;

  @Column({ name: 'decided_by_account_id', type: 'uuid', nullable: true })
  decidedByAccountId!: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ name: 'request_ip', type: 'varchar', nullable: true })
  requestIp!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
