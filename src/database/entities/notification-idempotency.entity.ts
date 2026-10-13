import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ServiceEntity } from './service.entity';

@Entity('notification_idempotency_keys')
@Index(['serviceId', 'idempotencyKey'], { unique: true })
export class NotificationIdempotencyEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ServiceEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'service_id' })
  service!: ServiceEntity;

  @Column({ name: 'service_id' })
  serviceId!: string;

  @Column({ name: 'idempotency_key' })
  idempotencyKey!: string;

  @Column({ name: 'payload_hash' })
  payloadHash!: string;

  @Column({ name: 'response_json', type: 'jsonb' })
  responseJson!: Record<string, unknown>;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
