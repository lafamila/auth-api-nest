import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AccountEntity } from './account.entity';
import { ServicePermissionDefinitionEntity } from './service-permission-definition.entity';
import { ServiceEntity } from './service.entity';

export type ServiceApplicationStatus = 'pending' | 'approved' | 'rejected';

@Entity('service_applications')
export class ServiceApplicationEntity {
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

  @Column({ type: 'text', default: '' })
  message!: string;

  @Column({ default: 'pending' })
  status!: ServiceApplicationStatus;

  @ManyToOne(() => ServicePermissionDefinitionEntity, { eager: true, nullable: true })
  @JoinColumn({ name: 'target_permission_definition_id' })
  targetPermissionDefinition!: ServicePermissionDefinitionEntity | null;

  @Column({
    name: 'target_permission_definition_id',
    type: 'uuid',
    nullable: true,
  })
  targetPermissionDefinitionId!: string | null;

  @Column({ name: 'reviewed_by_account_id', type: 'uuid', nullable: true })
  reviewedByAccountId!: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
