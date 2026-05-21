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
import { AccountEntity } from './account.entity';
import { ServicePermissionDefinitionEntity } from './service-permission-definition.entity';
import { ServiceEntity } from './service.entity';

export type AccountServicePermissionStatus = 'active' | 'suspended' | 'revoked';

@Entity('account_service_permissions')
@Index(['accountId', 'serviceId'], { unique: true })
export class AccountServicePermissionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => AccountEntity, { eager: true, nullable: false })
  @JoinColumn({ name: 'account_id' })
  account!: AccountEntity;

  @Column({ name: 'account_id' })
  accountId!: string;

  @ManyToOne(() => ServiceEntity, { eager: true, nullable: false })
  @JoinColumn({ name: 'service_id' })
  service!: ServiceEntity;

  @Column({ name: 'service_id' })
  serviceId!: string;

  @ManyToOne(() => ServicePermissionDefinitionEntity, {
    eager: true,
    nullable: false,
  })
  @JoinColumn({ name: 'permission_definition_id' })
  permissionDefinition!: ServicePermissionDefinitionEntity;

  @Column({ name: 'permission_definition_id' })
  permissionDefinitionId!: string;

  @Column({ default: 'active' })
  status!: AccountServicePermissionStatus;

  @Column({ name: 'granted_by_account_id', type: 'varchar', nullable: true })
  grantedByAccountId!: string | null;

  @Column({ name: 'granted_at', type: 'timestamptz' })
  grantedAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
