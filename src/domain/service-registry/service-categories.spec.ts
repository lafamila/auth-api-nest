import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { getMetadataArgsStorage, QueryRunner } from 'typeorm';
import {
  isServiceCategory,
  SERVICE_CATEGORIES,
  SERVICE_CATEGORY_KEYS,
  ServiceEntity,
} from '../../database/entities/service.entity';
import { AddServiceCategories20261118000003 } from '../../database/migrations/20261118000003-AddServiceCategories';
import {
  CreateServiceOnboardingRequestDto,
  UpdateServiceOnboardingRequestDto,
} from '../service-onboarding/dto/service-onboarding.dto';
import { CreateServiceDto, UpdateServiceDto } from './dto/service.dto';
import { ServiceCategoriesController } from './service-categories.controller';
import { ServiceRegistryModule } from './service-registry.module';

describe('Service categories', () => {
  it('exports the fixed taxonomy through the public catalog controller', () => {
    expect(SERVICE_CATEGORIES).toEqual([
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
    ]);
    expect(SERVICE_CATEGORY_KEYS).toEqual(
      SERVICE_CATEGORIES.map(({ key }) => key),
    );
    expect(new ServiceCategoriesController().list()).toBe(SERVICE_CATEGORIES);
    expect(Reflect.getMetadata('path', ServiceCategoriesController)).toBe(
      'api/service-categories',
    );
    expect(Reflect.getMetadata('controllers', ServiceRegistryModule)).toContain(
      ServiceCategoriesController,
    );
    expect(
      Reflect.getMetadata('__guards__', ServiceCategoriesController),
    ).toBeUndefined();
  });

  it('uses the same non-null default and constraint in entity metadata and migration', async () => {
    const column = getMetadataArgsStorage().columns.find(
      (entry) =>
        entry.target === ServiceEntity && entry.propertyName === 'category',
    );
    expect(column?.options).toMatchObject({
      default: 'other',
      type: 'varchar',
    });
    expect(column?.options.nullable).not.toBe(true);
    const check = getMetadataArgsStorage().checks.find(
      (entry) =>
        entry.target === ServiceEntity &&
        entry.name === 'chk_services_category',
    );
    expect(check?.expression).toBe(
      `"category" IN (${SERVICE_CATEGORY_KEYS.map((key) => `'${key}'`).join(', ')})`,
    );
    const query = jest.fn<Promise<unknown[]>, [string]>().mockResolvedValue([]);
    const runner = {
      query,
      isTransactionActive: true,
    } as unknown as QueryRunner;
    const migration = new AddServiceCategories20261118000003();
    await migration.up(runner);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("category varchar NOT NULL DEFAULT 'other'");
    expect(sql).toContain('CHECK (category IN (');
    const keys = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(keys).toEqual(['other', ...SERVICE_CATEGORY_KEYS]);
    expect(sql).not.toMatch(/UPDATE|service_key|name\s*=/i);
    await migration.down(runner);
    expect(query).toHaveBeenCalledWith(
      'LOCK TABLE services IN ACCESS EXCLUSIVE MODE',
    );
    expect(query.mock.calls.at(-1)![0]).toContain('DROP COLUMN category');
  });

  it('refuses rollback without transaction or when categories would be lost', async () => {
    const migration = new AddServiceCategories20261118000003();
    await expect(
      migration.down({ isTransactionActive: false } as QueryRunner),
    ).rejects.toThrow('active transaction');
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ category: 'game' }]);
    await expect(
      migration.down({
        query,
        isTransactionActive: true,
      } as unknown as QueryRunner),
    ).rejects.toThrow();
    expect(query.mock.calls.flat().join(' ')).not.toContain('DROP COLUMN');
  });

  describe.each([
    CreateServiceDto,
    UpdateServiceDto,
    CreateServiceOnboardingRequestDto,
    UpdateServiceOnboardingRequestDto,
  ])('%s category validation', (Dto) => {
    const spec = { serviceKey: 'test', name: 'Test', permissions: [] };

    it.each(SERVICE_CATEGORY_KEYS)('accepts %s', async (category) => {
      const errors = await validate(
        plainToInstance<object, object>(Dto, { ...spec, category }),
      );
      expect(errors.filter((error) => error.property === 'category')).toEqual(
        [],
      );
      expect(isServiceCategory(category)).toBe(true);
    });

    it('allows omission for backwards-compatible requests', async () => {
      const errors = await validate(plainToInstance<object, object>(Dto, spec));
      expect(errors.filter((error) => error.property === 'category')).toEqual(
        [],
      );
    });

    it.each([null, '', 'unknown', 'Game', {}, [], 1])(
      'rejects explicit invalid category %j',
      async (category) => {
        const errors = await validate(
          plainToInstance<object, object>(Dto, { ...spec, category }),
        );
        expect(errors.some((error) => error.property === 'category')).toBe(
          true,
        );
        expect(isServiceCategory(category)).toBe(false);
      },
    );
  });
});
