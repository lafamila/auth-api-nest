import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialAuthSchema20260521000000 implements MigrationInterface {
  name = 'InitialAuthSchema20260521000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE accounts (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        login_id varchar NOT NULL UNIQUE,
        name varchar NOT NULL,
        email varchar NOT NULL UNIQUE,
        password_hash varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'active',
        is_super_admin boolean NOT NULL DEFAULT false,
        last_login_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE services (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_key varchar NOT NULL UNIQUE,
        name varchar NOT NULL,
        description varchar NOT NULL DEFAULT '',
        status varchar NOT NULL DEFAULT 'active',
        permission_schema_version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE oidc_clients (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_id uuid NOT NULL REFERENCES services(id),
        client_id varchar NOT NULL UNIQUE,
        client_secret_hash varchar,
        client_type varchar NOT NULL,
        redirect_uris text[] NOT NULL,
        post_logout_redirect_uris text[] NOT NULL DEFAULT '{}',
        allowed_grant_types text[] NOT NULL,
        allowed_scopes text[] NOT NULL,
        require_pkce boolean NOT NULL DEFAULT true,
        status varchar NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE service_permission_definitions (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_id uuid NOT NULL REFERENCES services(id),
        key varchar NOT NULL,
        label varchar NOT NULL,
        description varchar NOT NULL DEFAULT '',
        status varchar NOT NULL DEFAULT 'active',
        sort_order integer NOT NULL DEFAULT 0,
        deprecated_at timestamptz,
        removed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(service_id, key)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE account_service_permissions (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        account_id uuid NOT NULL REFERENCES accounts(id),
        service_id uuid NOT NULL REFERENCES services(id),
        permission_definition_id uuid NOT NULL REFERENCES service_permission_definitions(id),
        status varchar NOT NULL DEFAULT 'active',
        granted_by_account_id uuid,
        granted_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(account_id, service_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        actor_account_id uuid,
        action varchar NOT NULL,
        target_type varchar NOT NULL,
        target_id varchar,
        before_json jsonb,
        after_json jsonb,
        ip_address varchar,
        user_agent varchar,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE token_records (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        token_hash varchar NOT NULL,
        type varchar NOT NULL,
        status varchar NOT NULL,
        family_id varchar,
        account_id varchar NOT NULL,
        client_id varchar NOT NULL,
        service_id varchar,
        metadata_json jsonb,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE signing_keys (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        kid varchar NOT NULL UNIQUE,
        private_key_pem text NOT NULL,
        public_key_jwk jsonb NOT NULL,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE signing_keys`);
    await queryRunner.query(`DROP TABLE token_records`);
    await queryRunner.query(`DROP TABLE audit_logs`);
    await queryRunner.query(`DROP TABLE account_service_permissions`);
    await queryRunner.query(`DROP TABLE service_permission_definitions`);
    await queryRunner.query(`DROP TABLE oidc_clients`);
    await queryRunner.query(`DROP TABLE services`);
    await queryRunner.query(`DROP TABLE accounts`);
  }
}
