import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationPlatform20261013000000 implements MigrationInterface {
  name = 'AddNotificationPlatform20261013000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE notification_devices (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        installation_id varchar NOT NULL,
        display_name varchar NOT NULL,
        platform varchar NOT NULL,
        app_version varchar NULL,
        build_number varchar NULL,
        encrypted_push_token text NULL,
        token_fingerprint varchar NULL UNIQUE,
        status varchar NOT NULL DEFAULT 'active',
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        disabled_at timestamptz NULL,
        deleted_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_notification_device_installation UNIQUE (account_id, installation_id),
        CONSTRAINT chk_notification_device_platform CHECK (platform IN ('ios', 'android')),
        CONSTRAINT chk_notification_device_status CHECK (status IN ('active', 'disabled'))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE notification_subscriptions (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        device_id uuid NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE,
        service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        enabled boolean NOT NULL DEFAULT false,
        consented_at timestamptz NULL,
        revoked_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_notification_subscription UNIQUE (device_id, service_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_notification_subscriptions_service_account
      ON notification_subscriptions(service_id, account_id, enabled)
    `);
    await queryRunner.query(`
      CREATE TABLE notification_action_targets (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        target_key varchar NOT NULL,
        base_url text NOT NULL,
        fallback_url text NULL,
        allowed_paths text[] NOT NULL,
        allowed_custom_schemes text[] NOT NULL DEFAULT '{}',
        status varchar NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_notification_action_target UNIQUE (service_id, target_key),
        CONSTRAINT chk_notification_action_target_status CHECK (status IN ('active', 'disabled'))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE notifications (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        service_credential_id uuid NOT NULL REFERENCES service_credentials(id) ON DELETE CASCADE,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        title varchar(160) NOT NULL,
        body text NOT NULL,
        metadata_json jsonb NULL,
        action_json jsonb NULL,
        status varchar NOT NULL DEFAULT 'accepted',
        deleted_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_notification_status CHECK (status IN ('accepted', 'delivered', 'partial', 'failed'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_notifications_account_created
      ON notifications(account_id, created_at DESC, id DESC)
    `);
    await queryRunner.query(`
      CREATE TABLE notification_deliveries (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        device_id uuid NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE,
        status varchar NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NULL DEFAULT now(),
        claim_token uuid NULL,
        provider_message_id varchar NULL,
        terminal_reason varchar NULL,
        delivered_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_notification_delivery UNIQUE (notification_id, device_id),
        CONSTRAINT chk_notification_delivery_status CHECK (status IN ('pending', 'processing', 'retry', 'delivered', 'terminal'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_notification_deliveries_due
      ON notification_deliveries(status, next_attempt_at)
    `);
    await queryRunner.query(`
      CREATE TABLE notification_delivery_attempts (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        delivery_id uuid NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
        attempt_number integer NOT NULL,
        provider_status varchar NOT NULL,
        provider_code varchar NULL,
        sanitized_error varchar NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_notification_delivery_attempt UNIQUE (delivery_id, attempt_number)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE notification_idempotency_keys (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        idempotency_key varchar NOT NULL,
        payload_hash varchar NOT NULL,
        response_json jsonb NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_notification_idempotency UNIQUE (service_id, idempotency_key)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_notification_idempotency_expiry
      ON notification_idempotency_keys(expires_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE notification_idempotency_keys');
    await queryRunner.query('DROP TABLE notification_delivery_attempts');
    await queryRunner.query('DROP TABLE notification_deliveries');
    await queryRunner.query('DROP TABLE notifications');
    await queryRunner.query('DROP TABLE notification_action_targets');
    await queryRunner.query('DROP TABLE notification_subscriptions');
    await queryRunner.query('DROP TABLE notification_devices');
  }
}
