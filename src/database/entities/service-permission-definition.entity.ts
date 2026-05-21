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

export type PermissionStatus = 'active' | 'deprecated' | 'removed';

@Entity('service_permission_definitions')
@Index(['serviceId', 'key'], { unique: true })
export class ServicePermissionDefinitionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ServiceEntity, { eager: true, nullable: false })
  @JoinColumn({ name: 'service_id' })
  service!: ServiceEntity;

  @Column({ name: 'service_id' })
  serviceId!: string;

  @Column()
  key!: string;

  @Column()
  label!: string;

  @Column({ default: '' })
  description!: string;

  @Column({ default: 'active' })
  status!: PermissionStatus;

  @Column({ name: 'sort_order', default: 0 })
  sortOrder!: number;

  @Column({ name: 'deprecated_at', type: 'timestamptz', nullable: true })
  deprecatedAt!: Date | null;

  @Column({ name: 'removed_at', type: 'timestamptz', nullable: true })
  removedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
