import { NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { AccountEntity } from '../../database/entities/account.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { TokenRecordEntity } from '../../database/entities/token-record.entity';
import { InternalServiceAccountSearchQueryDto } from '../../internal/dto/internal-service-account-search.dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AccountsService } from './accounts.service';

describe('Exact account directory search', () => {
  function setup() {
    const account = (
      id: string,
      loginId: string,
      name = 'Shared name',
      status = 'active',
    ) =>
      Object.assign(new AccountEntity(), {
        id,
        loginId,
        name,
        status,
        email: `${loginId}@example.test`,
        isSuperAdmin: false,
      });
    const rows = [
      ...Array.from({ length: 25 }, (_, i) =>
        account(`decoy-${i}`, `teddy-${i}`),
      ),
      account('target', 'Teddy', 'Exact name'),
      account('disabled', 'teddy', 'Exact name', 'disabled'),
    ];
    const accounts = { find: jest.fn().mockResolvedValue(rows) };
    const service = {
      findOneBy: jest.fn().mockResolvedValue({ id: 'chat-service' }),
    };
    const permissions = { find: jest.fn().mockResolvedValue([]) };
    const dataSource = {
      getRepository: jest.fn((entity) =>
        entity === ServiceEntity ? service : permissions,
      ),
    };
    const subject = new AccountsService(
      accounts as unknown as Repository<AccountEntity>,
      dataSource as unknown as DataSource,
      {} as PasswordService,
      {} as AuditLogsService,
      {} as Repository<TokenRecordEntity>,
    );
    return { subject, accounts, service, permissions };
  }

  it('finds an exact active login before the result limit without requiring a service assignment', async () => {
    const { subject, permissions } = setup();
    const result = await subject.searchForService('chat', ' TEDDY ', 'loginId');
    expect(result.map((item) => item.id)).toEqual(['target']);
    expect(result[0].permissionKey).toBe('visitor');
    expect(permissions.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          { accountId: 'target', serviceId: 'chat-service', status: 'active' },
        ],
      }),
    );
  });

  it('keeps name matching separate from login/email and does not enumerate empty exact queries', async () => {
    const { subject } = setup();
    expect(
      (await subject.searchForService('chat', 'exact NAME', 'name')).map(
        (item) => item.id,
      ),
    ).toEqual(['target']);
    expect(
      await subject.searchForService('chat', 'Teddy@example.test', 'loginId'),
    ).toEqual([]);
    expect(await subject.searchForService('chat', ' ', 'name')).toEqual([]);
  });

  it('preserves existing substring search behavior when no exact mode is requested', async () => {
    const { subject } = setup();
    const result = await subject.searchForService('chat', 'teddy-');
    expect(result).toHaveLength(20);
    expect(result[0].id).toBe('decoy-0');
  });

  it('requires an active registered calling service even in exact mode', async () => {
    const { subject, service, accounts } = setup();
    service.findOneBy.mockResolvedValue(null);
    await expect(
      subject.searchForService('missing', 'Teddy', 'loginId'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(accounts.find).not.toHaveBeenCalled();
  });

  it('rejects unsupported matching fields and oversized directory queries', async () => {
    const dto = Object.assign(new InternalServiceAccountSearchQueryDto(), {
      serviceKey: 'chat',
      q: 'a'.repeat(257),
      exactMatch: 'passwordHash',
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property).sort()).toEqual([
      'exactMatch',
      'q',
    ]);
  });
});
