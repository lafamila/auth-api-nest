import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ServiceEntity } from './service.entity';

export const PERMISSION_WEBHOOK_EVENT_TYPES = [
  'permission.updated',
  'service_application.rejected',
] as const;

export type PermissionWebhookEventType =
  (typeof PERMISSION_WEBHOOK_EVENT_TYPES)[number];
export type PermissionWebhookSecretSource = 'generated' | 'environment';
export type PermissionWebhookSubscriptionStatus = 'active' | 'disabled';

@Entity('permission_webhook_subscriptions')
@Index(['serviceId'], { unique: true })
export class PermissionWebhookSubscriptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ServiceEntity, { eager: true, nullable: false })
  @JoinColumn({ name: 'service_id' })
  service!: ServiceEntity;

  @Column({ name: 'service_id' })
  serviceId!: string;

  @Column({ name: 'endpoint_url', type: 'text' })
  endpointUrl!: string;

  @Column({ name: 'secret_source' })
  secretSource!: PermissionWebhookSecretSource;

  @Column({ name: 'encrypted_secret', type: 'text', nullable: true })
  encryptedSecret!: string | null;

  @Column({ name: 'event_types', type: 'text', array: true })
  eventTypes!: PermissionWebhookEventType[];

  @Column({ default: 'active' })
  status!: PermissionWebhookSubscriptionStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
