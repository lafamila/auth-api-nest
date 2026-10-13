import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { NotificationActionTargetEntity } from '../database/entities/notification-action-target.entity';
import { NotificationActionSnapshot } from '../database/entities/notification.entity';
import { ServiceEntity } from '../database/entities/service.entity';
import { AuditLogsService } from '../domain/audit-logs/audit-logs.service';
import {
  NotificationActionDto,
  OnboardingNotificationActionTargetDto,
} from './dto/notification.dto';

@Injectable()
export class NotificationActionTargetsService {
  constructor(
    @InjectRepository(NotificationActionTargetEntity)
    private readonly targets: Repository<NotificationActionTargetEntity>,
    private readonly auditLogs: AuditLogsService,
  ) {}

  validateRequestedSpec(
    requested: OnboardingNotificationActionTargetDto[] | undefined,
  ): void {
    if (requested === undefined) {
      return;
    }
    const keys = new Set<string>();
    for (const target of requested) {
      if (keys.has(target.targetKey)) {
        throw new BadRequestException(
          `Duplicate notification action target ${target.targetKey}`,
        );
      }
      keys.add(target.targetKey);
      this.normalizedHttpsBase(target.baseUrl, 'baseUrl');
      if (target.fallbackUrl) {
        this.normalizedHttpsBase(target.fallbackUrl, 'fallbackUrl');
      }
      target.allowedPaths.forEach((path) => this.validatePathPattern(path));
      (target.allowedCustomSchemes ?? []).forEach((scheme) => {
        if (
          !/^[a-z][a-z0-9+.-]{1,63}$/.test(scheme) ||
          scheme === 'http' ||
          scheme === 'https'
        ) {
          throw new BadRequestException(
            `Invalid custom scheme for ${target.targetKey}`,
          );
        }
      });
    }
  }

  async configureFromApprovedOnboarding(
    service: ServiceEntity,
    requested: OnboardingNotificationActionTargetDto[] | undefined,
  ): Promise<void> {
    if (requested === undefined) {
      return;
    }
    this.validateRequestedSpec(requested);
    const requestedKeys = requested.map((target) => target.targetKey);
    if (requestedKeys.length > 0) {
      await this.targets.update(
        { serviceId: service.id, targetKey: In(requestedKeys) },
        { status: 'disabled' },
      );
    }
    const existing = await this.targets.findBy({ serviceId: service.id });
    const byKey = new Map(existing.map((target) => [target.targetKey, target]));
    for (const spec of requested) {
      const target = byKey.get(spec.targetKey) ?? this.targets.create();
      target.serviceId = service.id;
      target.targetKey = spec.targetKey;
      target.baseUrl = this.normalizedHttpsBase(spec.baseUrl, 'baseUrl');
      target.fallbackUrl = spec.fallbackUrl
        ? this.normalizedHttpsBase(spec.fallbackUrl, 'fallbackUrl')
        : null;
      target.allowedPaths = [...new Set(spec.allowedPaths)];
      target.allowedCustomSchemes = [
        ...new Set(spec.allowedCustomSchemes ?? []),
      ];
      target.status = 'active';
      await this.targets.save(target);
    }
    const omitted = existing.filter(
      (target) => !requestedKeys.includes(target.targetKey),
    );
    if (omitted.length > 0) {
      await this.targets.update(
        { id: In(omitted.map((target) => target.id)) },
        { status: 'disabled' },
      );
    }
  }

  async resolve(
    serviceId: string,
    action?: NotificationActionDto,
  ): Promise<NotificationActionSnapshot | null> {
    if (!action) {
      return null;
    }
    const target = await this.targets.findOneBy({
      serviceId,
      targetKey: action.targetKey,
      status: 'active',
    });
    if (!target) {
      throw new ForbiddenException('notification_action_not_allowed');
    }
    const path = this.validateActionPath(action.path);
    if (!target.allowedPaths.some((pattern) => pathMatches(pattern, path))) {
      throw new ForbiddenException('notification_action_not_allowed');
    }
    return {
      targetKey: target.targetKey,
      path,
      url: new URL(path, target.baseUrl).toString(),
      fallbackUrl: target.fallbackUrl
        ? new URL(path, target.fallbackUrl).toString()
        : null,
      allowedCustomSchemes: [...target.allowedCustomSchemes],
    };
  }

  list(): Promise<NotificationActionTargetEntity[]> {
    return this.targets.find({
      relations: { service: true },
      order: { createdAt: 'DESC' },
    });
  }

  async setStatus(
    id: string,
    status: 'active' | 'disabled',
    actorAccountId: string,
  ): Promise<NotificationActionTargetEntity> {
    const target = await this.targets.findOneByOrFail({ id });
    const before = { status: target.status };
    target.status = status;
    const saved = await this.targets.save(target);
    await this.auditLogs.record({
      actorAccountId,
      action: 'notification.action_target.status',
      targetType: 'notification_action_target',
      targetId: saved.id,
      beforeJson: before,
      afterJson: { status: saved.status },
    });
    return saved;
  }

  private normalizedHttpsBase(value: string, field: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException(`Notification action ${field} is invalid`);
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new BadRequestException(
        `Notification action ${field} must be a credential-free HTTPS origin without path, query or fragment`,
      );
    }
    return url.toString();
  }

  private validatePathPattern(pattern: string): void {
    const base = pattern.endsWith('/**')
      ? pattern.slice(0, -3) || '/'
      : pattern;
    if (pattern.includes('*') && !pattern.endsWith('/**')) {
      throw new BadRequestException(
        'Notification allowed paths support only a trailing /** wildcard',
      );
    }
    this.validateActionPath(base);
  }

  private validateActionPath(path: string): string {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('\\') ||
      path.includes('?') ||
      path.includes('#')
    ) {
      throw new ForbiddenException('notification_action_not_allowed');
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new ForbiddenException('notification_action_not_allowed');
    }
    try {
      if (decodeURIComponent(decoded) !== decoded) {
        throw new ForbiddenException('notification_action_not_allowed');
      }
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      // A literal percent encoded as %25 is not recursive encoding.
    }
    if (
      decoded.startsWith('//') ||
      decoded.includes('//') ||
      decoded.includes('\\') ||
      decoded.includes('?') ||
      decoded.includes('#') ||
      [...decoded].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      }) ||
      decoded.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      throw new ForbiddenException('notification_action_not_allowed');
    }
    let canonical: string;
    try {
      canonical = decoded
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    } catch {
      throw new ForbiddenException('notification_action_not_allowed');
    }
    if (canonical !== path) {
      throw new ForbiddenException('notification_action_not_allowed');
    }
    return canonical;
  }
}

function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.endsWith('/**')) {
    return pattern === path;
  }
  const prefix = pattern.slice(0, -3) || '/';
  return path === prefix || path.startsWith(`${prefix}/`);
}
