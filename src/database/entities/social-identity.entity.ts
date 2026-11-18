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

@Entity('social_identities')
@Index(['provider', 'providerClientId', 'subject'], { unique: true })
export class SocialIdentityEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @ManyToOne(() => AccountEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account!: AccountEntity;

  @Column({ type: 'varchar', length: 40 })
  provider!: string;

  @Column({ name: 'provider_client_id', type: 'varchar', length: 512 })
  providerClientId!: string;

  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  @Column({ name: 'encrypted_revocation_grant', type: 'text', nullable: true })
  encryptedRevocationGrant!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
