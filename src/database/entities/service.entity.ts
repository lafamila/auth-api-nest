import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ServiceStatus = 'active' | 'disabled' | 'archived';

@Entity('services')
export class ServiceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'service_key' })
  serviceKey!: string;

  @Column()
  name!: string;

  @Column({ default: '' })
  description!: string;

  @Column({ default: 'active' })
  status!: ServiceStatus;

  @Column({ name: 'permission_schema_version', default: 1 })
  permissionSchemaVersion!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
