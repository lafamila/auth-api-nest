import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ServiceEntity } from './service.entity';

export type OidcClientType = 'public' | 'confidential';
export type OidcClientStatus = 'active' | 'disabled';

@Entity('oidc_clients')
export class OidcClientEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ServiceEntity, { eager: true, nullable: false })
  @JoinColumn({ name: 'service_id' })
  service!: ServiceEntity;

  @Column({ name: 'service_id' })
  serviceId!: string;

  @Index({ unique: true })
  @Column({ name: 'client_id' })
  clientId!: string;

  @Column({ name: 'client_secret_hash', type: 'varchar', nullable: true })
  clientSecretHash!: string | null;

  @Column({ name: 'client_type' })
  clientType!: OidcClientType;

  @Column({ name: 'redirect_uris', type: 'text', array: true })
  redirectUris!: string[];

  @Column({ name: 'post_logout_redirect_uris', type: 'text', array: true, default: [] })
  postLogoutRedirectUris!: string[];

  @Column({ name: 'allowed_grant_types', type: 'text', array: true })
  allowedGrantTypes!: string[];

  @Column({ name: 'allowed_scopes', type: 'text', array: true })
  allowedScopes!: string[];

  @Column({ name: 'require_pkce', default: true })
  requirePkce!: boolean;

  @Column({ default: 'active' })
  status!: OidcClientStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
