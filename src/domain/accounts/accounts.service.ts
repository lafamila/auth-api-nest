import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { PasswordService } from '../../common/crypto/password.service';
import {
  ADMIN_TEMPORARY_RESET_PASSWORD,
  validateNormalPassword,
  validatePasswordOrTemporaryReset,
} from '../../common/crypto/password-policy';
import { AccountServicePermissionEntity } from '../../database/entities/account-service-permission.entity';
import { AccountEntity } from '../../database/entities/account.entity';
import { AdminSessionEntity } from '../../database/entities/admin-session.entity';
import { ServiceEntity } from '../../database/entities/service.entity';
import { TokenRecordEntity } from '../../database/entities/token-record.entity';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { VISITOR_PERMISSION } from '../permissions/visitor-permission';
import { CreateAccountDto, UpdateAccountDto } from './dto/account.dto';

export interface ServiceAccountSearchResult {
  id: string;
  loginId: string | null;
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
    @InjectRepository(TokenRecordEntity)
    private readonly tokenRecords: Repository<TokenRecordEntity>,
  ) {}

  list(): Promise<AccountEntity[]> {
    return this.accounts.find({ order: { createdAt: 'DESC' } });
  }

  async searchForService(
    serviceKey: string,
    query: string,
    exactMatch?: 'loginId' | 'name',
  ): Promise<ServiceAccountSearchResult[]> {
    const service = await this.dataSource
      .getRepository(ServiceEntity)
      .findOneBy({ serviceKey, status: 'active' });
    if (!service) {
      throw new NotFoundException('Service not found');
    }

    const normalizedQuery = query.trim().toLowerCase();
    const accounts = (
      await this.accounts.find({ order: { createdAt: 'DESC' } })
    )
      .filter((account) => {
        if (exactMatch) {
          return (
            Boolean(normalizedQuery) &&
            account.status === 'active' &&
            account[exactMatch]?.trim().toLowerCase() === normalizedQuery
          );
        }
        if (!normalizedQuery) return true;
        return [account.loginId, account.name, account.email]
          .filter((value): value is string => typeof value === 'string')
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
      permissionKey:
        permissionByAccountId.get(account.id) ?? VISITOR_PERMISSION.key,
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
    if (typeof loginId !== 'string' || !loginId.trim()) {
      return Promise.resolve(null);
    }
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
    options?: {
      emailVerifiedAt?: Date | null;
      passwordResetRequired?: boolean;
    },
  ): Promise<AccountEntity> {
    const exists = await this.accounts.exists({
      where: [{ loginId: input.loginId }, { email: input.email }],
    });
    if (exists) {
      throw new ConflictException('Account loginId or email already exists');
    }
    validateNormalPassword(input.password);
    const passwordHash = await this.passwordService.hash(input.password);
    return this.dataSource.transaction(async (manager) => {
      const account = await manager.save(
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
      );
      await this.auditLogs.record(
        {
          actorAccountId,
          action: 'account.create',
          targetType: 'account',
          targetId: account.id,
          afterJson: this.safeAccount(account),
        },
        manager,
      );
      return account;
    });
  }

  async createSocialAccount(
    input: {
      email: string;
      name: string;
      loginId?: string;
      password?: string;
    },
    manager: EntityManager,
  ): Promise<AccountEntity> {
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    const loginId = input.loginId?.trim() || null;
    const password = input.password || null;
    if (!email || !name) {
      throw new BadRequestException('Email and name are required');
    }
    if (Boolean(loginId) !== Boolean(password)) {
      throw new BadRequestException(
        'Login ID and password must be provided together',
      );
    }
    let passwordHash: string | null = null;
    if (password) {
      validateNormalPassword(password);
      passwordHash = await this.passwordService.hash(password);
    }
    const account = manager.create(AccountEntity, {
      loginId,
      passwordHash,
      email,
      name,
      status: 'active',
      isSuperAdmin: false,
      passwordResetRequired: false,
      // The social flow verifies email ownership before creating an account.
      emailVerifiedAt: new Date(),
    });
    let saved: AccountEntity;
    try {
      saved = await manager.save(account);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        error.driverError?.code === '23505'
      ) {
        throw new ConflictException('Account loginId or email already exists');
      }
      throw error;
    }
    await this.auditLogs.record(
      {
        action: 'account.create',
        targetType: 'account',
        targetId: saved.id,
        afterJson: this.safeAccount(saved),
      },
      manager,
    );
    return saved;
  }

  async update(id: string, input: UpdateAccountDto): Promise<AccountEntity> {
    const saved = await this.dataSource.transaction(async (manager) => {
      const accountRepository = manager.getRepository(AccountEntity);
      const account = await accountRepository.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!account) {
        throw new NotFoundException('Account not found');
      }
      const invalidatesSessions =
        input.status !== undefined && input.status !== 'active';
      if (
        invalidatesSessions &&
        account.status === 'active' &&
        account.isSuperAdmin
      ) {
        const activeSuperAdminCount = await accountRepository.countBy({
          isSuperAdmin: true,
          status: 'active',
        });
        if (activeSuperAdminCount <= 1) {
          throw new ConflictException(
            'Cannot disable the last active super admin',
          );
        }
      }
      const before = this.safeAccount(account);
      const changes = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(invalidatesSessions
          ? { credentialVersion: (account.credentialVersion ?? 0) + 1 }
          : {}),
      };
      if (Object.keys(changes).length > 0) {
        await accountRepository.update(id, changes);
      }
      const updated = Object.assign(account, changes);
      if (invalidatesSessions) {
        await this.revokeAccountSessions(updated.id, manager);
      }
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
    if (!account.loginId || !account.passwordHash) {
      throw new ConflictException('Account does not have local credentials');
    }
    const nextPassword = password ?? ADMIN_TEMPORARY_RESET_PASSWORD;
    const resetRequired = validatePasswordOrTemporaryReset(nextPassword);
    const passwordHash = await this.passwordService.hash(nextPassword);
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(AccountEntity);
      const current = await repository.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new NotFoundException('Account not found');
      if (!current.loginId || !current.passwordHash) {
        throw new ConflictException('Account does not have local credentials');
      }
      await repository.update(id, {
        passwordHash,
        passwordResetRequired: resetRequired,
        credentialVersion: (current.credentialVersion ?? 0) + 1,
      });
      await this.revokeAccountSessions(id, manager);
      await this.auditLogs.record(
        {
          action: 'account.reset_password',
          targetType: 'account',
          targetId: id,
        },
        manager,
      );
    });
  }

  async revokeAccountSessions(
    accountId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const repository = manager
      ? manager.getRepository(TokenRecordEntity)
      : this.tokenRecords;
    await repository.update(
      {
        accountId,
        type: In([
          'refresh_token',
          'sso_session',
          'portal_session',
          'portal_mfa',
          'authorization_code',
          'authorization_login',
        ]),
        status: In(['active', 'used']),
      },
      { status: 'revoked' },
    );
    const adminSessions = (manager ?? this.dataSource).getRepository(
      AdminSessionEntity,
    );
    await adminSessions.update(
      { accountId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  async authenticate(
    loginId: string,
    password: string,
  ): Promise<AccountEntity> {
    if (typeof password !== 'string' || !password) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const account = await this.findByLoginId(loginId);
    if (
      !account ||
      account.status !== 'active' ||
      !account.loginId ||
      !account.passwordHash
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await this.passwordService.verify(
      account.passwordHash,
      password,
    );
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (account.passwordResetRequired) {
      throw new UnauthorizedException('Password reset is required');
    }
    account.lastLoginAt = new Date();
    await this.accounts.update(account.id, {
      lastLoginAt: account.lastLoginAt,
    });
    return account;
  }

  async authenticateIgnoringResetRequirement(
    loginId: string,
    password: string,
  ): Promise<AccountEntity> {
    if (typeof password !== 'string' || !password) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const account = await this.findByLoginId(loginId);
    if (
      !account ||
      account.status !== 'active' ||
      !account.loginId ||
      !account.passwordHash
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await this.passwordService.verify(
      account.passwordHash,
      password,
    );
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
    const passwordHash = await this.passwordService.hash(newPassword);
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(AccountEntity);
      const current = await repository.findOne({
        where: { id: account.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !current ||
        current.status !== 'active' ||
        !current.loginId ||
        !current.passwordHash ||
        current.passwordHash !== account.passwordHash ||
        (current.credentialVersion ?? 0) !== (account.credentialVersion ?? 0)
      ) {
        throw new UnauthorizedException('Invalid credentials');
      }
      if (!current.passwordResetRequired) {
        throw new ConflictException('Password reset is not required');
      }
      const changes = {
        passwordHash,
        passwordResetRequired: false,
        credentialVersion: (current.credentialVersion ?? 0) + 1,
        lastLoginAt: new Date(),
      };
      await repository.update(current.id, changes);
      await this.revokeAccountSessions(current.id, manager);
      return Object.assign(current, changes);
    });
  }

  safeAccount(account: AccountEntity): Record<string, unknown> {
    return {
      id: account.id,
      loginId: account.loginId,
      hasLocalCredentials: Boolean(account.loginId && account.passwordHash),
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
