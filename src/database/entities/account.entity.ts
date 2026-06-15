import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AccountStatus = 'active' | 'locked' | 'disabled';

@Entity('accounts')
export class AccountEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'login_id' })
  loginId!: string;

  @Column()
  name!: string;

  @Index({ unique: true })
  @Column()
  email!: string;

  @Column({ name: 'password_hash' })
  passwordHash!: string;

  @Column({ default: 'active' })
  status!: AccountStatus;

  @Column({ name: 'is_super_admin', default: false })
  isSuperAdmin!: boolean;

  @Column({ name: 'password_reset_required', default: false })
  passwordResetRequired!: boolean;

  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt!: Date | null;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
