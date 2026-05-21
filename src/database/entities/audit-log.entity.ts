import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('audit_logs')
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'actor_account_id', type: 'varchar', nullable: true })
  actorAccountId!: string | null;

  @Column()
  action!: string;

  @Column({ name: 'target_type' })
  targetType!: string;

  @Column({ name: 'target_id', type: 'varchar', nullable: true })
  targetId!: string | null;

  @Column({ name: 'before_json', type: 'jsonb', nullable: true })
  beforeJson!: Record<string, unknown> | null;

  @Column({ name: 'after_json', type: 'jsonb', nullable: true })
  afterJson!: Record<string, unknown> | null;

  @Column({ name: 'ip_address', type: 'varchar', nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'varchar', nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
