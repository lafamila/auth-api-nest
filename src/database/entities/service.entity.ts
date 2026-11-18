import {
  Column,
  Check,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ServiceStatus = 'active' | 'disabled' | 'archived';

export const SERVICE_CATEGORIES = [
  { key: 'game', label: '게임·게임관련' },
  { key: 'productivity', label: '생산성·업무' },
  { key: 'education', label: '교육·학습' },
  { key: 'community', label: '커뮤니티·소셜' },
  { key: 'communication', label: '커뮤니케이션' },
  { key: 'content', label: '콘텐츠·미디어' },
  { key: 'travel', label: '여행·지역' },
  { key: 'health', label: '건강·운동' },
  { key: 'finance', label: '금융' },
  { key: 'commerce', label: '쇼핑·커머스' },
  { key: 'developer_tools', label: '개발·운영도구' },
  { key: 'other', label: '기타·미분류' },
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]['key'];
export const SERVICE_CATEGORY_KEYS = SERVICE_CATEGORIES.map(({ key }) => key);

export function isServiceCategory(value: unknown): value is ServiceCategory {
  return SERVICE_CATEGORY_KEYS.some((key) => key === value);
}

@Entity('services')
@Check(
  'chk_services_category',
  `"category" IN (${SERVICE_CATEGORY_KEYS.map((key) => `'${key}'`).join(', ')})`,
)
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

  @Column({ type: 'varchar', default: 'other' })
  category!: ServiceCategory;

  @Column({ default: 'active' })
  status!: ServiceStatus;

  @Column({ name: 'permission_schema_version', default: 1 })
  permissionSchemaVersion!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
