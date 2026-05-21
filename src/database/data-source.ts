import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AUTH_ENTITIES } from './database.module';

export default new DataSource({
  type: 'postgres',
  url:
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/teddy_auth',
  entities: AUTH_ENTITIES,
  migrations: ['dist/database/migrations/*.js'],
});
