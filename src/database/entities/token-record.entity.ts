import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type TokenRecordType = 'authorization_code' | 'refresh_token';
export type TokenRecordStatus = 'active' | 'used' | 'revoked';

@Entity('token_records')
export class TokenRecordEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'token_hash' })
  tokenHash!: string;

  @Column()
  type!: TokenRecordType;

  @Column()
  status!: TokenRecordStatus;

  @Column({ name: 'family_id', type: 'varchar', nullable: true })
  familyId!: string | null;

  @Column({ name: 'account_id' })
  accountId!: string;

  @Column({ name: 'client_id' })
  clientId!: string;

  @Column({ name: 'service_id', type: 'varchar', nullable: true })
  serviceId!: string | null;

  @Column({ name: 'metadata_json', type: 'jsonb', nullable: true })
  metadataJson!: Record<string, unknown> | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
