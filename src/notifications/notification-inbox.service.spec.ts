import { Repository } from 'typeorm';
import { NotificationEntity } from '../database/entities/notification.entity';
import { NotificationInboxService } from './notification-inbox.service';

describe('NotificationInboxService', () => {
  it('uses entity property paths for joined pagination queries', async () => {
    const builder = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(builder),
    } as unknown as Repository<NotificationEntity>;
    const service = new NotificationInboxService(repository);

    await expect(service.list('account-1', { limit: 30 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(builder.where).toHaveBeenCalledWith(
      'notification.accountId = :accountId',
      { accountId: 'account-1' },
    );
    expect(builder.orderBy).toHaveBeenCalledWith(
      'notification.createdAt',
      'DESC',
    );
    expect(builder.take).toHaveBeenCalledWith(31);
  });
});
