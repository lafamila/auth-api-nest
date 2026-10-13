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
import { NotificationDeviceEntity } from './notification-device.entity';
import { NotificationEntity } from './notification.entity';

export type NotificationDeliveryStatus =
  | 'pending'
  | 'processing'
  | 'retry'
  | 'delivered'
  | 'terminal';

@Entity('notification_deliveries')
@Index(['notificationId', 'deviceId'], { unique: true })
export class NotificationDeliveryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => NotificationEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification!: NotificationEntity;

  @Column({ name: 'notification_id' })
  notificationId!: string;

  @ManyToOne(() => NotificationDeviceEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'device_id' })
  device!: NotificationDeviceEntity;

  @Column({ name: 'device_id' })
  deviceId!: string;

  @Column({ default: 'pending' })
  status!: NotificationDeliveryStatus;

  @Column({ default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'claim_token', type: 'uuid', nullable: true })
  claimToken!: string | null;

  @Column({ name: 'provider_message_id', type: 'varchar', nullable: true })
  providerMessageId!: string | null;

  @Column({ name: 'terminal_reason', type: 'varchar', nullable: true })
  terminalReason!: string | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
