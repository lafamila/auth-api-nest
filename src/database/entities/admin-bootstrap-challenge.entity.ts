import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('admin_bootstrap_challenges')
export class AdminBootstrapChallengeEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'login_id' })
  loginId!: string;

  @Column()
  name!: string;

  @Index()
  @Column()
  email!: string;

  @Column({ name: 'password_hash' })
  passwordHash!: string;

  @Column({ name: 'encrypted_otp_secret', type: 'text' })
  encryptedOtpSecret!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
