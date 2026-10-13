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

export type NotificationActionTargetStatus = 'active' | 'disabled';

@Entity('notification_action_targets')
@Index(['serviceId', 'targetKey'], { unique: true })
export class NotificationActionTargetEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ServiceEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'service_id' })
  service!: ServiceEntity;

  @Column({ name: 'service_id' })
  serviceId!: string;

  @Column({ name: 'target_key' })
  targetKey!: string;

  @Column({ name: 'base_url', type: 'text' })
  baseUrl!: string;

  @Column({ name: 'fallback_url', type: 'text', nullable: true })
  fallbackUrl!: string | null;

  @Column({ name: 'allowed_paths', type: 'text', array: true })
  allowedPaths!: string[];

  @Column({
    name: 'allowed_custom_schemes',
    type: 'text',
    array: true,
    default: [],
  })
  allowedCustomSchemes!: string[];

  @Column({ default: 'active' })
  status!: NotificationActionTargetStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
