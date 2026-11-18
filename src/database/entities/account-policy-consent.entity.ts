import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AccountEntity } from './account.entity';

@Entity('account_policy_consents')
@Index(['accountId', 'termsVersion', 'privacyVersion', 'policyDigest'], {
  unique: true,
})
export class AccountPolicyConsentEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'account_id', type: 'uuid' }) accountId!: string;
  @ManyToOne(() => AccountEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'account_id' })
  account!: AccountEntity;
  @Column({ name: 'terms_version', length: 64 }) termsVersion!: string;
  @Column({ name: 'privacy_version', length: 64 }) privacyVersion!: string;
  @Column({ name: 'policy_digest', length: 64 }) policyDigest!: string;
  @Column({ length: 32 }) source!: 'signup' | 'social_signup' | 'portal';
  @CreateDateColumn({ name: 'accepted_at', type: 'timestamptz' })
  acceptedAt!: Date;
}
