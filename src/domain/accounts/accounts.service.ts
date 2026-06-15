import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import {
  ADMIN_TEMPORARY_RESET_PASSWORD,
  validateNormalPassword,
  validatePasswordOrTemporaryReset,
} from '../../common/crypto/password-policy';
import { AccountServicePermissionEntity } from '../../database/entities/account-service-permission.entity';
import { AccountEntity } from '../../database/entities/account.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { VISITOR_PERMISSION } from '../permissions/visitor-permission';
import { CreateAccountDto, UpdateAccountDto } from './dto/account.dto';

export interface ServiceAccountSearchResult {
  id: string;
  loginId: string;
  name: string;
  email: string;
  status: string;
  isSuperAdmin: boolean;
  permissionKey: string;
}

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(AccountEntity)
    private readonly accounts: Repository<AccountEntity>,
    private readonly dataSource: DataSource,
    private readonly passwordService: PasswordService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  list(): Promise<AccountEntity[]> {
    return this.accounts.find({ order: { createdAt: 'DESC' } });
  }

  async searchForService(
    serviceKey: string,
    query: string,
  ): Promise<ServiceAccountSearchResult[]> {
    const service = await this.dataSource
      .getRepository(ServiceEntity)
      .findOneBy({ serviceKey, status: 'active' });
    if (!service) {
      throw new NotFoundException('Service not found');
    }

    const normalizedQuery = query.trim().toLowerCase();
    const accounts = (await this.accounts.find({ order: { createdAt: 'DESC' } }))
      .filter((account) => {
        if (!normalizedQuery) return true;
        return [account.loginId, account.name, account.email]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .slice(0, 20);

    if (accounts.length === 0) {
      return [];
    }

    const permissions = await this.dataSource
      .getRepository(AccountServicePermissionEntity)
      .find({
        where: accounts.map((account) => ({
          accountId: account.id,
          serviceId: service.id,
          status: 'active',
        })),
        relations: {
          permissionDefinition: true,
        },
      });
    const permissionByAccountId = new Map(
      permissions.map((permission) => [
        permission.accountId,
        permission.permissionDefinition.key,
      ]),
    );

    return accounts.map((account) => ({
      id: account.id,
      loginId: account.loginId,
      name: account.name,
      email: account.email,
      status: account.status,
      isSuperAdmin: account.isSuperAdmin,
      permissionKey: permissionByAccountId.get(account.id) ?? VISITOR_PERMISSION.key,
    }));
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

  findByEmail(email: string): Promise<AccountEntity | null> {
    return this.accounts.findOneBy({ email });
  }

  countActiveSuperAdmins(): Promise<number> {
    return this.accounts.countBy({ isSuperAdmin: true, status: 'active' });
  }

  async create(
    input: CreateAccountDto,
    actorAccountId?: string | null,
    options?: { emailVerifiedAt?: Date | null; passwordResetRequired?: boolean },
  ): Promise<AccountEntity> {
    const exists = await this.accounts.exists({
      where: [{ loginId: input.loginId }, { email: input.email }],
    });
    if (exists) {
      throw new ConflictException('Account loginId or email already exists');
    }
    validateNormalPassword(input.password);
    const passwordHash = await this.passwordService.hash(input.password);
    const account = await this.dataSource.transaction(async (manager) =>
      manager.save(
        manager.create(AccountEntity, {
          loginId: input.loginId,
          name: input.name,
          email: input.email,
          passwordHash,
          isSuperAdmin: input.isSuperAdmin ?? false,
          status: 'active',
          passwordResetRequired: options?.passwordResetRequired ?? false,
          emailVerifiedAt: options?.emailVerifiedAt ?? null,
        }),
      ),
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
    const saved = await this.dataSource.transaction(async (manager) => {
      const accountRepository = manager.getRepository(AccountEntity);
      const account = await accountRepository.findOneBy({ id });
      if (!account) {
        throw new NotFoundException('Account not found');
      }
      if (
        input.status === 'disabled' &&
        account.status === 'active' &&
        account.isSuperAdmin
      ) {
        const activeSuperAdminCount = await accountRepository.countBy({
          isSuperAdmin: true,
          status: 'active',
        });
        if (activeSuperAdminCount <= 1) {
          throw new ConflictException('Cannot disable the last active super admin');
        }
      }
      const before = this.safeAccount(account);
      Object.assign(account, input);
      const updated = await accountRepository.save(account);
      return { before, updated };
    });
    await this.auditLogs.record({
      action: 'account.update',
      targetType: 'account',
      targetId: saved.updated.id,
      beforeJson: saved.before,
      afterJson: this.safeAccount(saved.updated),
    });
    return saved.updated;
  }

  async resetPassword(id: string, password?: string): Promise<void> {
    const account = await this.findById(id);
    const nextPassword = password ?? ADMIN_TEMPORARY_RESET_PASSWORD;
    const resetRequired = validatePasswordOrTemporaryReset(nextPassword);
    account.passwordHash = await this.passwordService.hash(nextPassword);
    account.passwordResetRequired = resetRequired;
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
    if (account.passwordResetRequired) {
      throw new UnauthorizedException('Password reset is required');
    }
    account.lastLoginAt = new Date();
    return this.accounts.save(account);
  }

  async authenticateIgnoringResetRequirement(
    loginId: string,
    password: string,
  ): Promise<AccountEntity> {
    const account = await this.findByLoginId(loginId);
    if (!account || account.status !== 'active') {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await this.passwordService.verify(account.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return account;
  }

  async completePasswordReset(
    loginId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<AccountEntity> {
    const account = await this.authenticateIgnoringResetRequirement(
      loginId,
      currentPassword,
    );
    if (!account.passwordResetRequired) {
      throw new ConflictException('Password reset is not required');
    }
    validateNormalPassword(newPassword);
    account.passwordHash = await this.passwordService.hash(newPassword);
    account.passwordResetRequired = false;
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
      passwordResetRequired: account.passwordResetRequired,
      emailVerifiedAt: account.emailVerifiedAt,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastLoginAt: account.lastLoginAt,
    };
  }
}
