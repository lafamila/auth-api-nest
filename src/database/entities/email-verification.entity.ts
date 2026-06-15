import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('email_verifications')
export class EmailVerificationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  email!: string;

  @Column({ name: 'code_hash' })
  codeHash!: string;

  @Column({ name: 'request_ip', type: 'varchar', nullable: true })
  requestIp!: string | null;

  @Column({ name: 'attempt_count', default: 0 })
  attemptCount!: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
