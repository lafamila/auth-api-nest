import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { NotificationDeliveryEntity } from './notification-delivery.entity';

@Entity('notification_delivery_attempts')
@Index(['deliveryId', 'attemptNumber'], { unique: true })
export class NotificationDeliveryAttemptEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => NotificationDeliveryEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'delivery_id' })
  delivery!: NotificationDeliveryEntity;

  @Column({ name: 'delivery_id' })
  deliveryId!: string;

  @Column({ name: 'attempt_number' })
  attemptNumber!: number;

  @Column({ name: 'provider_status' })
  providerStatus!: string;

  @Column({ name: 'provider_code', type: 'varchar', nullable: true })
  providerCode!: string | null;

  @Column({ name: 'sanitized_error', type: 'varchar', nullable: true })
  sanitizedError!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
