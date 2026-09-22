import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { EntityManager, FindOptionsWhere, Repository } from 'typeorm';
import { AesGcmService } from '../../common/crypto/aes-gcm.service';
import { AppConfigService } from '../../config/app-config.service';
import {
  PermissionWebhookDeliveryStatus,
  PermissionWebhookOutboxEntity,
} from '../../database/entities/permission-webhook-outbox.entity';
import {
  PERMISSION_WEBHOOK_EVENT_TYPES,
  PermissionWebhookEventType,
  PermissionWebhookSecretSource,
  PermissionWebhookSubscriptionEntity,
} from '../../database/entities/permission-webhook-subscription.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { PermissionWebhookEvent } from './permission-webhook.contract';
import {
  parsePermissionWebhookUrl,
  resolvePermissionWebhookTarget,
} from './permission-webhook-url';

export interface PermissionWebhookOnboardingSpec {
  url: string;
  signingSecretSource?: PermissionWebhookSecretSource;
  eventTypes?: PermissionWebhookEventType[];
}

export interface PermissionWebhookSecretResult {
  kind: 'permission_webhook';
  secret: string;
}

@Injectable()
export class PermissionWebhooksService {
  constructor(
    @InjectRepository(PermissionWebhookSubscriptionEntity)
    private readonly subscriptions: Repository<PermissionWebhookSubscriptionEntity>,
    @InjectRepository(PermissionWebhookOutboxEntity)
    private readonly outbox: Repository<PermissionWebhookOutboxEntity>,
    private readonly config: AppConfigService,
    private readonly aes: AesGcmService,
  ) {}

  validateRequestedSpec(spec?: PermissionWebhookOnboardingSpec | null): void {
    if (!spec) {
      return;
    }
    // DNS resolution is intentionally deferred until trusted admin approval.
    parsePermissionWebhookUrl(
      spec.url,
      this.config.permissionWebhookTrustedInternalOrigins,
    );
  }

  async configureFromApprovedOnboarding(
    service: ServiceEntity,
    spec?: PermissionWebhookOnboardingSpec | null,
  ): Promise<PermissionWebhookSecretResult | null> {
    if (spec === undefined) {
      return null;
    }
    if (!this.config.permissionWebhooksEnabled) {
      if (spec !== null) {
        throw new ServiceUnavailableException(
          'Permission webhooks require the database migration and PERMISSION_WEBHOOKS_ENABLED=true',
        );
      }
      return null;
    }
    const existing = await this.subscriptions.findOneBy({
      serviceId: service.id,
    });
    if (spec === null) {
      if (existing) {
        existing.status = 'disabled';
        await this.subscriptions.save(existing);
      }
      return null;
    }
    await this.assertApprovedEndpoint(spec.url);
    const source = spec.signingSecretSource ?? 'generated';
    const eventTypes = spec.eventTypes?.length
      ? spec.eventTypes
      : [...PERMISSION_WEBHOOK_EVENT_TYPES];
    let revealedSecret: string | null = null;
    let encryptedSecret: string | null = null;
    if (source === 'environment') {
      this.environmentSecret(service.serviceKey);
    } else if (
      existing?.secretSource === 'generated' &&
      existing.encryptedSecret
    ) {
      encryptedSecret = existing.encryptedSecret;
    } else {
      revealedSecret = randomBytes(32).toString('base64url');
      encryptedSecret = this.aes.encrypt(revealedSecret);
    }
    const subscription =
      existing ??
      this.subscriptions.create({
        service,
        serviceId: service.id,
      });
    subscription.endpointUrl = spec.url;
    subscription.secretSource = source;
    subscription.encryptedSecret = encryptedSecret;
    subscription.eventTypes = eventTypes;
    subscription.status = 'active';
    await this.subscriptions.save(subscription);
    return revealedSecret
      ? { kind: 'permission_webhook', secret: revealedSecret }
      : null;
  }

  async enqueue(
    manager: EntityManager,
    serviceId: string,
    event: PermissionWebhookEvent,
  ): Promise<void> {
    await this.enqueueMany(manager, serviceId, [event]);
  }

  async enqueueMany(
    manager: EntityManager,
    serviceId: string,
    events: PermissionWebhookEvent[],
  ): Promise<void> {
    if (!this.config.permissionWebhooksEnabled) {
      return;
    }
    const subscription = await manager.findOne(
      PermissionWebhookSubscriptionEntity,
      { where: { serviceId, status: 'active' } },
    );
    if (!subscription) {
      return;
    }
    const subscribedEvents = events.filter((event) =>
      subscription.eventTypes.includes(event.type),
    );
    if (subscribedEvents.length === 0) {
      return;
    }
    await manager.save(
      subscribedEvents.map((event) =>
        manager.create(PermissionWebhookOutboxEntity, {
          id: event.id,
          serviceId,
          eventType: event.type,
          eventJson: event as unknown as Record<string, unknown>,
          status: 'pending' as const,
          attempts: 0,
          nextAttemptAt: new Date(),
          claimToken: null,
          deliveredAt: null,
          lastResponseStatus: null,
          lastResponseBody: null,
          lastError: null,
        }),
      ),
    );
  }

  async findSubscription(serviceId: string) {
    try {
      const subscription = await this.subscriptions.findOne({
        where: { serviceId },
        relations: { service: true },
      });
      return subscription ? this.safeSubscription(subscription) : null;
    } catch (error) {
      if (hasPostgresCode(error, '42P01')) {
        return null;
      }
      throw error;
    }
  }

  async setStatus(serviceId: string, status: 'active' | 'disabled') {
    this.assertEnabled();
    const subscription = await this.requireSubscription(serviceId);
    if (status === 'active') {
      await this.assertApprovedEndpoint(subscription.endpointUrl);
      if (subscription.secretSource === 'environment') {
        this.environmentSecret(subscription.service.serviceKey);
      }
    }
    subscription.status = status;
    return this.safeSubscription(await this.subscriptions.save(subscription));
  }

  async rotateSecret(serviceId: string) {
    this.assertEnabled();
    const subscription = await this.requireSubscription(serviceId);
    if (subscription.secretSource !== 'generated') {
      throw new BadRequestException(
        'Environment-backed webhook secrets must be rotated in the auth environment',
      );
    }
    const secret = randomBytes(32).toString('base64url');
    subscription.encryptedSecret = this.aes.encrypt(secret);
    const saved = await this.subscriptions.save(subscription);
    return { subscription: this.safeSubscription(saved), secret };
  }

  async listDeliveries(
    serviceId: string,
    status?: PermissionWebhookDeliveryStatus,
    requestedPage = 1,
    requestedPageSize = 25,
  ) {
    this.assertEnabled();
    await this.requireSubscription(serviceId);
    const pageSize = Math.min(Math.max(requestedPageSize, 1), 100);
    const where: FindOptionsWhere<PermissionWebhookOutboxEntity> = {
      serviceId,
      ...(status ? { status } : {}),
    };
    const total = await this.outbox.countBy(where);
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const page =
      totalPages === 0 ? 1 : Math.min(Math.max(requestedPage, 1), totalPages);
    const items = await this.outbox.find({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: items.map((item) => this.safeDelivery(item)),
      page,
      pageSize,
      total,
      totalPages,
    };
  }

  async retryDelivery(serviceId: string, eventId: string) {
    this.assertEnabled();
    const event = await this.outbox.findOneBy({ id: eventId, serviceId });
    if (!event) {
      throw new NotFoundException('Permission webhook delivery not found');
    }
    event.status = 'pending';
    event.attempts = 0;
    event.nextAttemptAt = new Date();
    event.claimToken = null;
    event.deliveredAt = null;
    event.lastResponseStatus = null;
    event.lastResponseBody = null;
    event.lastError = null;
    return this.safeDelivery(await this.outbox.save(event));
  }

  secretFor(subscription: PermissionWebhookSubscriptionEntity): string {
    if (subscription.secretSource === 'environment') {
      return this.environmentSecret(subscription.service.serviceKey).secret;
    }
    if (!subscription.encryptedSecret) {
      throw new Error('Generated permission webhook secret is missing');
    }
    return this.aes.decrypt(subscription.encryptedSecret);
  }

  private async assertApprovedEndpoint(endpointUrl: string): Promise<void> {
    await resolvePermissionWebhookTarget(
      endpointUrl,
      this.config.permissionWebhookTrustedInternalOrigins,
    );
  }

  private environmentSecret(serviceKey: string) {
    const result = this.config.permissionWebhookEnvironmentSecret(serviceKey);
    if (result.secret.length < 32) {
      throw new BadRequestException(
        `${result.envName} must contain at least 32 characters`,
      );
    }
    return result;
  }

  private async requireSubscription(
    serviceId: string,
  ): Promise<PermissionWebhookSubscriptionEntity> {
    const subscription = await this.subscriptions.findOne({
      where: { serviceId },
      relations: { service: true },
    });
    if (!subscription) {
      throw new NotFoundException('Permission webhook subscription not found');
    }
    return subscription;
  }

  private assertEnabled(): void {
    if (!this.config.permissionWebhooksEnabled) {
      throw new ServiceUnavailableException(
        'Permission webhooks are not enabled',
      );
    }
  }

  private safeSubscription(subscription: PermissionWebhookSubscriptionEntity) {
    return {
      id: subscription.id,
      serviceId: subscription.serviceId,
      serviceKey: subscription.service?.serviceKey,
      endpointUrl: subscription.endpointUrl,
      secretSource: subscription.secretSource,
      eventTypes: subscription.eventTypes,
      status: subscription.status,
      deliveryEnabled: this.config.permissionWebhooksEnabled,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
    };
  }

  private safeDelivery(delivery: PermissionWebhookOutboxEntity) {
    return {
      id: delivery.id,
      serviceId: delivery.serviceId,
      eventType: delivery.eventType,
      event: delivery.eventJson,
      status: delivery.status,
      attempts: delivery.attempts,
      nextAttemptAt: delivery.nextAttemptAt,
      deliveredAt: delivery.deliveredAt,
      lastResponseStatus: delivery.lastResponseStatus,
      lastResponseBody: delivery.lastResponseBody,
      lastError: delivery.lastError,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
    };
  }
}

function hasPostgresCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
