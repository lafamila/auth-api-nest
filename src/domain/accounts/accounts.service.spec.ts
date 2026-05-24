import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { AccountEntity } from '../../database/entities/account.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AccountsService } from './accounts.service';

describe('AccountsService', () => {
  it('prevents disabling the last active super admin', async () => {
    const account = {
      id: 'super-admin-id',
      loginId: 'superadmin',
      name: 'Super Admin',
      email: 'superadmin@example.invalid',
      passwordHash: 'hash',
      status: 'active',
      isSuperAdmin: true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as AccountEntity;
    const accountRepository = {
      findOneBy: jest.fn().mockResolvedValue(account),
      countBy: jest.fn().mockResolvedValue(1),
      save: jest.fn(),
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue(accountRepository),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(
        async (callback: (manager: EntityManager) => Promise<unknown>) =>
          callback(manager),
      ),
    } as unknown as DataSource;
    const service = new AccountsService(
      {} as Repository<AccountEntity>,
      dataSource,
      {} as PasswordService,
      { record: jest.fn() } as unknown as AuditLogsService,
    );

    await expect(service.update(account.id, { status: 'disabled' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(accountRepository.save).not.toHaveBeenCalled();
  });
});
