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

export const SERVICE_CREDENTIAL_SCOPE_DEFINITIONS = [
  {
    key: 'account.search',
    label: 'Account Search',
    description: 'Allows a service backend to search auth accounts.',
  },
  {
    key: 'permission.read',
    label: 'Permission Read',
    description:
      'Allows a service backend to read permission upgrade request status and current permissions.',
  },
] as const;

export type ServiceCredentialScope =
  (typeof SERVICE_CREDENTIAL_SCOPE_DEFINITIONS)[number]['key'];
export const SERVICE_CREDENTIAL_SCOPE_KEYS =
  SERVICE_CREDENTIAL_SCOPE_DEFINITIONS.map(
    (scope) => scope.key,
  ) as ServiceCredentialScope[];
export type ServiceCredentialStatus = 'active' | 'disabled';

@Entity('service_credentials')
export class ServiceCredentialEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ServiceEntity, { eager: true, nullable: false })
  @JoinColumn({ name: 'service_id' })
  service!: ServiceEntity;

  @Column({ name: 'service_id' })
  serviceId!: string;

  @Index({ unique: true })
  @Column({ name: 'key_id' })
  keyId!: string;

  @Column({ name: 'secret_hash' })
  secretHash!: string;

  @Column()
  name!: string;

  @Column({ type: 'text', default: '' })
  description!: string;

  @Column('text', { array: true, default: () => "'{}'" })
  scopes!: ServiceCredentialScope[];

  @Column({ default: 'active' })
  status!: ServiceCredentialStatus;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: 'last_used_from', type: 'varchar', nullable: true })
  lastUsedFrom!: string | null;

  @Column({ name: 'rotated_at', type: 'timestamptz', nullable: true })
  rotatedAt!: Date | null;

  @Column({ name: 'disabled_at', type: 'timestamptz', nullable: true })
  disabledAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
