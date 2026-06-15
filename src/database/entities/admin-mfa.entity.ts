import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AccountEntity } from './account.entity';

@Entity('admin_mfa')
export class AdminMfaEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @OneToOne(() => AccountEntity, { eager: true, nullable: false })
  @JoinColumn({ name: 'account_id' })
  account!: AccountEntity;

  @Index({ unique: true })
  @Column({ name: 'account_id' })
  accountId!: string;

  @Column({ name: 'encrypted_otp_secret', type: 'text' })
  encryptedOtpSecret!: string;

  @Column({ default: 'SHA1' })
  algorithm!: string;

  @Column({ default: 6 })
  digits!: number;

  @Column({ default: 30 })
  period!: number;

  @Column({ name: 'verified_at', type: 'timestamptz' })
  verifiedAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
