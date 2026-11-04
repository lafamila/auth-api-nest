import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { AuthorizeRequestInput } from '../../oidc/authorize-flow.service';
import type { SocialIdentityProfile } from '../../social/social-provider.types';

export interface SocialLoginData {
  request: AuthorizeRequestInput;
  sessionAccountId: string | null;
  providerClientId: string;
  encryptedVerifier?: string;
  profile?: SocialIdentityProfile;
  email?: string;
  emailVerified?: boolean;
  emailVerificationId?: string;
  lastEmailSentAt?: string;
}

@Entity('social_login_transactions')
@Check(
  'chk_social_transaction_phase',
  "phase IN ('authorization', 'processing', 'signup')",
)
export class SocialLoginTransactionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'token_hash', type: 'varchar' })
  tokenHash!: string;

  @Column({ name: 'browser_binding_hash', type: 'varchar' })
  browserBindingHash!: string;

  @Column({ type: 'varchar', length: 40 })
  provider!: string;

  @Column({ type: 'varchar' })
  phase!: 'authorization' | 'processing' | 'signup';

  @Column({ name: 'data_json', type: 'jsonb' })
  data!: SocialLoginData;

  @Index()
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
