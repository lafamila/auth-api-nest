import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PermissionWebhookEventType } from './permission-webhook-subscription.entity';
import { ServiceEntity } from './service.entity';

export type PermissionWebhookDeliveryStatus =
  | 'pending'
  | 'delivered'
  | 'exhausted';

@Entity('permission_webhook_outbox')
@Index(['status', 'nextAttemptAt'])
@Index(['serviceId', 'createdAt'])
export class PermissionWebhookOutboxEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @ManyToOne(() => ServiceEntity, { eager: false, nullable: false })
  @JoinColumn({ name: 'service_id' })
  service!: ServiceEntity;

  @Column({ name: 'service_id' })
  serviceId!: string;

  @Column({ name: 'event_type' })
  eventType!: PermissionWebhookEventType;

  @Column({ name: 'event_json', type: 'jsonb' })
  eventJson!: Record<string, unknown>;

  @Column({ default: 'pending' })
  status!: PermissionWebhookDeliveryStatus;

  @Column({ default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'claim_token', type: 'uuid', nullable: true })
  claimToken!: string | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @Column({ name: 'last_response_status', type: 'int', nullable: true })
  lastResponseStatus!: number | null;

  @Column({ name: 'last_response_body', type: 'text', nullable: true })
  lastResponseBody!: string | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
