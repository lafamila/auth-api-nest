import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AccountStatus = 'active' | 'locked' | 'disabled';

@Entity('accounts')
@Check(
  'chk_accounts_local_credentials_pair',
  '(login_id IS NULL) = (password_hash IS NULL)',
)
@Check(
  'chk_accounts_password_reset_local_credentials',
  'password_hash IS NOT NULL OR NOT password_reset_required',
)
export class AccountEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'login_id', type: 'varchar', nullable: true })
  loginId!: string | null;

  @Column()
  name!: string;

  @Index({ unique: true })
  @Column()
  email!: string;

  @Column({ name: 'password_hash', type: 'varchar', nullable: true })
  passwordHash!: string | null;

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
