import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPermissionWebhooks20260922000000 implements MigrationInterface {
  name = 'AddPermissionWebhooks20260922000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE permission_webhook_subscriptions (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        endpoint_url text NOT NULL,
        secret_source varchar NOT NULL,
        encrypted_secret text NULL,
        event_types text[] NOT NULL,
        status varchar NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_permission_webhook_subscription_service UNIQUE (service_id),
        CONSTRAINT chk_permission_webhook_secret_source
          CHECK (secret_source IN ('generated', 'environment')),
        CONSTRAINT chk_permission_webhook_subscription_status
          CHECK (status IN ('active', 'disabled'))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE permission_webhook_outbox (
        id uuid PRIMARY KEY,
        service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        event_type varchar NOT NULL,
        event_json jsonb NOT NULL,
        status varchar NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NULL DEFAULT now(),
        claim_token uuid NULL,
        delivered_at timestamptz NULL,
        last_response_status integer NULL,
        last_response_body text NULL,
        last_error text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_permission_webhook_outbox_status
          CHECK (status IN ('pending', 'delivered', 'exhausted')),
        CONSTRAINT chk_permission_webhook_outbox_event_type
          CHECK (event_type IN ('permission.updated', 'service_application.rejected'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_permission_webhook_outbox_due
      ON permission_webhook_outbox(status, next_attempt_at)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_permission_webhook_outbox_service_created
      ON permission_webhook_outbox(service_id, created_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE permission_webhook_outbox');
    await queryRunner.query('DROP TABLE permission_webhook_subscriptions');
  }
}
