import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { NotificationEntity } from '../database/entities/notification.entity';
import { NotificationInboxQueryDto } from './dto/notification.dto';

@Injectable()
export class NotificationInboxService {
  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notifications: Repository<NotificationEntity>,
  ) {}

  async list(accountId: string, query: NotificationInboxQueryDto) {
    const limit = query.limit ?? 30;
    const builder = this.notifications
      .createQueryBuilder('notification')
      .innerJoinAndSelect('notification.service', 'service')
      .where('notification.account_id = :accountId', { accountId })
      .andWhere('notification.deleted_at IS NULL')
      .orderBy('notification.created_at', 'DESC')
      .addOrderBy('notification.id', 'DESC')
      .take(limit + 1);
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      builder.andWhere(
        '(notification.created_at, notification.id) < (:createdAt, :id)',
        cursor,
      );
    }
    const rows = await builder.getMany();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      items: page.map((notification) => ({
        id: notification.id,
        title: notification.title,
        bodyPreview:
          notification.body.length > 180
            ? `${notification.body.slice(0, 180)}...`
            : notification.body,
        serviceKey: notification.service.serviceKey,
        serviceName: notification.service.name,
        hasAction: Boolean(notification.actionJson),
        status: notification.status,
        receivedAt: notification.createdAt,
      })),
      nextCursor:
        hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  async detail(accountId: string, notificationId: string) {
    const notification = await this.notifications.findOne({
      where: { id: notificationId, accountId, deletedAt: IsNull() },
      relations: { service: true },
    });
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    return {
      id: notification.id,
      title: notification.title,
      body: notification.body,
      metadata: notification.metadataJson,
      action: notification.actionJson
        ? {
            targetKey: notification.actionJson.targetKey,
            path: notification.actionJson.path,
            uri: notification.actionJson.url,
            fallbackUri: notification.actionJson.fallbackUrl,
          }
        : null,
      serviceKey: notification.service.serviceKey,
      serviceName: notification.service.name,
      status: notification.status,
      receivedAt: notification.createdAt,
    };
  }

  async remove(accountId: string, notificationId: string): Promise<void> {
    const result = await this.notifications.update(
      { id: notificationId, accountId, deletedAt: IsNull() },
      { deletedAt: new Date() },
    );
    if (!result.affected) {
      throw new NotFoundException('Notification not found');
    }
  }
}

function encodeCursor(notification: NotificationEntity): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: notification.createdAt.toISOString(),
      id: notification.id,
    }),
  ).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.createdAt !== 'string' ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(parsed.id)
    ) {
      throw new Error('invalid');
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new NotFoundException('Notification cursor is invalid');
  }
}
