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

@Entity('admin_sessions')
export class AdminSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => AccountEntity, { eager: true, nullable: false })
  @JoinColumn({ name: 'account_id' })
  account!: AccountEntity;

  @Column({ name: 'account_id' })
  accountId!: string;

  @Index({ unique: true })
  @Column({ name: 'token_hash' })
  tokenHash!: string;

  @Column({ name: 'idle_expires_at', type: 'timestamptz' })
  idleExpiresAt!: Date;

  @Column({ name: 'absolute_expires_at', type: 'timestamptz' })
  absoluteExpiresAt!: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'ip_address', type: 'varchar', nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
