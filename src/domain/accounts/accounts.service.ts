import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import { AccountEntity } from '../../database/entities/account.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateAccountDto, UpdateAccountDto } from './dto/account.dto';

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(AccountEntity)
    private readonly accounts: Repository<AccountEntity>,
    private readonly passwordService: PasswordService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  list(): Promise<AccountEntity[]> {
    return this.accounts.find({ order: { createdAt: 'DESC' } });
  }

  async findById(id: string): Promise<AccountEntity> {
    const account = await this.accounts.findOneBy({ id });
    if (!account) {
      throw new NotFoundException('Account not found');
    }
    return account;
  }

  findByLoginId(loginId: string): Promise<AccountEntity | null> {
    return this.accounts.findOneBy({ loginId });
  }

  async create(input: CreateAccountDto, actorAccountId?: string | null): Promise<AccountEntity> {
    const exists = await this.accounts.exists({
      where: [{ loginId: input.loginId }, { email: input.email }],
    });
    if (exists) {
      throw new ConflictException('Account loginId or email already exists');
    }
    const account = await this.accounts.save(
      this.accounts.create({
        loginId: input.loginId,
        name: input.name,
        email: input.email,
        passwordHash: await this.passwordService.hash(input.password),
        isSuperAdmin: input.isSuperAdmin ?? false,
        status: 'active',
      }),
    );
    await this.auditLogs.record({
      actorAccountId,
      action: 'account.create',
      targetType: 'account',
      targetId: account.id,
      afterJson: this.safeAccount(account),
    });
    return account;
  }

  async update(id: string, input: UpdateAccountDto): Promise<AccountEntity> {
    const account = await this.findById(id);
    const before = this.safeAccount(account);
    Object.assign(account, input);
    const saved = await this.accounts.save(account);
    await this.auditLogs.record({
      action: 'account.update',
      targetType: 'account',
      targetId: saved.id,
      beforeJson: before,
      afterJson: this.safeAccount(saved),
    });
    return saved;
  }

  async resetPassword(id: string, password: string): Promise<void> {
    const account = await this.findById(id);
    account.passwordHash = await this.passwordService.hash(password);
    await this.accounts.save(account);
    await this.auditLogs.record({
      action: 'account.reset_password',
      targetType: 'account',
      targetId: id,
    });
  }

  async authenticate(loginId: string, password: string): Promise<AccountEntity> {
    const account = await this.findByLoginId(loginId);
    if (!account || account.status !== 'active') {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await this.passwordService.verify(account.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }
    account.lastLoginAt = new Date();
    return this.accounts.save(account);
  }

  safeAccount(account: AccountEntity): Record<string, unknown> {
    return {
      id: account.id,
      loginId: account.loginId,
      name: account.name,
      email: account.email,
      status: account.status,
      isSuperAdmin: account.isSuperAdmin,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastLoginAt: account.lastLoginAt,
    };
  }
}
