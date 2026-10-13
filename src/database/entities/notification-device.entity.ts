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

export type NotificationPlatform = 'ios' | 'android';
export type NotificationDeviceStatus = 'active' | 'disabled';

@Entity('notification_devices')
@Index(['accountId', 'installationId'], { unique: true })
export class NotificationDeviceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => AccountEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account!: AccountEntity;

  @Column({ name: 'account_id' })
  accountId!: string;

  @Column({ name: 'installation_id' })
  installationId!: string;

  @Column({ name: 'display_name' })
  displayName!: string;

  @Column()
  platform!: NotificationPlatform;

  @Column({ name: 'app_version', type: 'varchar', nullable: true })
  appVersion!: string | null;

  @Column({ name: 'build_number', type: 'varchar', nullable: true })
  buildNumber!: string | null;

  @Column({ name: 'encrypted_push_token', type: 'text', nullable: true })
  encryptedPushToken!: string | null;

  @Index({ unique: true })
  @Column({ name: 'token_fingerprint', type: 'varchar', nullable: true })
  tokenFingerprint!: string | null;

  @Column({ default: 'active' })
  status!: NotificationDeviceStatus;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt!: Date;

  @Column({ name: 'disabled_at', type: 'timestamptz', nullable: true })
  disabledAt!: Date | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
