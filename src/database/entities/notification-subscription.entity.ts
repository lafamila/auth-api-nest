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
import { AccountEntity } from './account.entity';
import { NotificationDeviceEntity } from './notification-device.entity';
import { ServiceEntity } from './service.entity';

@Entity('notification_subscriptions')
@Index(['deviceId', 'serviceId'], { unique: true })
export class NotificationSubscriptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => AccountEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account!: AccountEntity;

  @Column({ name: 'account_id' })
  accountId!: string;

  @ManyToOne(() => NotificationDeviceEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'device_id' })
  device!: NotificationDeviceEntity;

  @Column({ name: 'device_id' })
  deviceId!: string;

  @ManyToOne(() => ServiceEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'service_id' })
  service!: ServiceEntity;

  @Column({ name: 'service_id' })
  serviceId!: string;

  @Column({ default: false })
  enabled!: boolean;

  @Column({ name: 'consented_at', type: 'timestamptz', nullable: true })
  consentedAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
