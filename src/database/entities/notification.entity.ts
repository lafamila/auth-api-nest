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
import { ServiceCredentialEntity } from './service-credential.entity';
import { ServiceEntity } from './service.entity';

export type NotificationStatus =
  | 'accepted'
  | 'delivered'
  | 'partial'
  | 'failed';

export interface NotificationActionSnapshot {
  targetKey: string;
  path: string;
  url: string;
  fallbackUrl: string | null;
  allowedCustomSchemes: string[];
}

@Entity('notifications')
@Index(['accountId', 'createdAt', 'id'])
export class NotificationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ServiceEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'service_id' })
  service!: ServiceEntity;

  @Column({ name: 'service_id' })
  serviceId!: string;

  @ManyToOne(() => ServiceCredentialEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'service_credential_id' })
  serviceCredential!: ServiceCredentialEntity;

  @Column({ name: 'service_credential_id' })
  serviceCredentialId!: string;

  @ManyToOne(() => AccountEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account!: AccountEntity;

  @Column({ name: 'account_id' })
  accountId!: string;

  @Column({ length: 160 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ name: 'metadata_json', type: 'jsonb', nullable: true })
  metadataJson!: Record<string, string | number | boolean | null> | null;

  @Column({ name: 'action_json', type: 'jsonb', nullable: true })
  actionJson!: NotificationActionSnapshot | null;

  @Column({ default: 'accepted' })
  status!: NotificationStatus;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
