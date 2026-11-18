import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { PasswordService } from '../common/crypto/password.service';
import { hashSecret } from '../common/crypto/secret-hash';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { AccountEntity } from '../database/entities/account.entity';
import { AdminSessionEntity } from '../database/entities/admin-session.entity';
import { AuditLogEntity } from '../database/entities/audit-log.entity';
import { ServiceOnboardingRequestEntity } from '../database/entities/service-onboarding-request.entity';
import { SocialIdentityEntity } from '../database/entities/social-identity.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { AccountsService } from '../domain/accounts/accounts.service';
import { createPermissionWebhookEvent } from '../domain/permission-webhooks/permission-webhook.contract';
import { PermissionWebhooksService } from '../domain/permission-webhooks/permission-webhooks.service';
import { ProviderRevocationsService } from '../social/provider-revocations.service';
import {
  ProviderEventIdentitySnapshot,
  providerEventIdentitySnapshot,
} from '../social/provider-events/provider-event.types';
import {
  AccountLifecycleOverview,
  UNLINK_CONFIRMATION,
  UnlinkProviderDto,
  UnlinkProviderResult,
  WITHDRAW_CONFIRMATION,
  WithdrawAccountDto,
  WithdrawAccountResult,
} from './account-lifecycle.dto';
import { PORTAL_CLIENT_ID, PortalActor, RECENT_AUTH_MS } from './portal.types';

// All active-superadmin removal paths must take this lock before any account lock.
export const LAST_ACTIVE_SUPERADMIN_LOCK = 'auth:last-active-superadmin';
const PROVIDERS = ['google', 'kakao', 'naver'];

@Injectable()
export class AccountLifecycleService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly accounts: AccountsService,
    private readonly passwords: PasswordService,
    private readonly providerRevocations: ProviderRevocationsService,
    @Optional()
    private readonly permissionWebhooks?: PermissionWebhooksService,
  ) {}

  async overview(actor: PortalActor): Promise<AccountLifecycleOverview> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockAdministration(manager);
      const account = await this.lockActor(manager, actor, false);
      const identities = await this.identities(manager, account.id);
      const lastAdmin = await this.isLastActiveAdmin(manager, account);
      const providerReason = this.providerBlocker(identities);
      const blockedReason = lastAdmin
        ? 'last_active_superadmin'
        : providerReason;
      return {
        accountDeletion: {
          allowed: blockedReason === null,
          blockedReason,
          serviceDataPolicy: 'separate',
        },
        connections: [...new Set(identities.map((row) => row.provider))]
          .sort()
          .map((provider) => {
            const selected = identities.filter(
              (row) => row.provider === provider,
            );
            const grantReason = this.providerBlocker(selected);
            const reason =
              !this.hasLocalCredentials(account) &&
              selected.length === identities.length
                ? 'last_login_method'
                : grantReason;
            return {
              provider,
              identityCount: selected.length,
              canUnlink: reason === null,
              reason,
              requiresProviderAuthentication:
                grantReason === 'provider_reauthentication_required',
            };
          }),
      };
    });
  }

  async unlink(
    actor: PortalActor,
    provider: string,
    input: UnlinkProviderDto,
  ): Promise<UnlinkProviderResult> {
    this.assertProvider(provider);
    this.assertConfirmation(input.confirmation, UNLINK_CONFIRMATION);
    return this.dataSource.transaction(async (manager) => {
      await this.lockAdministration(manager);
      const account = await this.lockActor(manager, actor, true);
      await this.requireCurrentPassword(account, input.currentPassword);
      const identities = await this.identities(manager, account.id);
      const selected = identities.filter((row) => row.provider === provider);
      if (!selected.length)
        throw new NotFoundException('Provider is not linked');
      if (
        !this.hasLocalCredentials(account) &&
        selected.length === identities.length
      ) {
        throw new ConflictException({
          code: 'last_login_method',
          message: 'Register another login method before unlinking',
        });
      }
      this.providerRevocations.prepare(selected);
      const pendingProviderRevocations = await this.providerRevocations.enqueue(
        manager,
        selected,
        'unlink',
      );
      await this.invalidateSessions(manager, account);
      await manager.delete(SocialIdentityEntity, {
        accountId: account.id,
        id: In(selected.map((identity) => identity.id)),
      });
      return { ok: true, reauthenticate: true, pendingProviderRevocations };
    });
  }

  async withdraw(
    actor: PortalActor,
    input: WithdrawAccountDto,
  ): Promise<WithdrawAccountResult> {
    this.assertConfirmation(input.confirmation, WITHDRAW_CONFIRMATION);
    return this.dataSource.transaction(async (manager) => {
      await this.lockAdministration(manager);
      const account = await this.lockActor(manager, actor, true);
      await this.requireCurrentPassword(account, input.currentPassword);
      if (await this.isLastActiveAdmin(manager, account))
        throw this.lastAdminError();
      const identities = await this.identities(manager, account.id);
      this.providerRevocations.prepare(identities);
      const pendingProviderRevocations = await this.providerRevocations.enqueue(
        manager,
        identities,
        'withdraw',
      );
      await this.deleteAuthAccount(manager, account, identities);
      return { withdrawn: true, pendingProviderRevocations };
    });
  }

  /** Only authenticated, provider/client-bound event receivers may call this. */
  async consumeProviderEvent(
    provider: string,
    clientId: string,
    subject: string,
    kind: 'unlinked' | 'sessions_revoked',
    expectedSnapshot?: ProviderEventIdentitySnapshot | null,
  ): Promise<void> {
    this.assertProvider(provider);
    if (
      typeof clientId !== 'string' ||
      !clientId ||
      clientId.length > 512 ||
      typeof subject !== 'string' ||
      !subject ||
      subject.length > 255 ||
      !['unlinked', 'sessions_revoked'].includes(kind)
    )
      throw new BadRequestException('Invalid provider event');
    if (expectedSnapshot === null) return;
    if (
      expectedSnapshot !== undefined &&
      (typeof expectedSnapshot !== 'object' ||
        typeof expectedSnapshot.identityId !== 'string' ||
        !expectedSnapshot.identityId ||
        !/^[a-f0-9]{64}$/.test(expectedSnapshot.grantDigest))
    )
      throw new BadRequestException('Invalid provider event snapshot');
    const identity = await this.dataSource
      .getRepository(SocialIdentityEntity)
      .findOneBy({ provider, providerClientId: clientId, subject });
    if (!identity) return;
    const manualRecovery = await this.dataSource.transaction(
      async (manager) => {
        await this.lockAdministration(manager);
        const account = await manager.findOne(AccountEntity, {
          where: { id: identity.accountId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!account) return false;
        const identities = await this.identities(manager, account.id);
        const current = identities.find(
          (row) =>
            row.id === identity.id &&
            row.provider === provider &&
            row.providerClientId === clientId &&
            row.subject === subject,
        );
        if (!current) return false;
        if (expectedSnapshot) {
          const snapshot = providerEventIdentitySnapshot(current);
          if (
            snapshot.identityId !== expectedSnapshot.identityId ||
            snapshot.grantDigest !== expectedSnapshot.grantDigest
          )
            return false;
        }
        if (kind === 'sessions_revoked') {
          await this.invalidateSessions(manager, account);
          return false;
        }
        if (!this.hasLocalCredentials(account) && identities.length === 1) {
          if (await this.isLastActiveAdmin(manager, account)) {
            // Commit revocation, retaining the active admin so bootstrap stays closed.
            await this.invalidateSessions(manager, account);
            await manager.update(SocialIdentityEntity, current.id, {
              encryptedRevocationGrant: null,
            });
            return true;
          }
          // This grant is already revoked upstream; never require or queue it again.
          await this.deleteAuthAccount(manager, account, identities);
        } else {
          await this.invalidateSessions(manager, account);
          await manager.delete(SocialIdentityEntity, {
            id: current.id,
            accountId: account.id,
          });
        }
        return false;
      },
    );
    if (manualRecovery) throw this.lastAdminError();
  }

  private async lockAdministration(manager: EntityManager): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [LAST_ACTIVE_SUPERADMIN_LOCK],
    );
  }

  private async lockActor(
    manager: EntityManager,
    actor: PortalActor,
    recent: boolean,
  ): Promise<AccountEntity> {
    if (
      !actor?.account?.id ||
      !actor.session?.id ||
      !actor.session.tokenHash ||
      actor.session.accountId !== actor.account.id
    )
      throw new UnauthorizedException('Invalid portal session');
    const account = await manager.findOne(AccountEntity, {
      where: { id: actor.account.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !account ||
      account.status !== 'active' ||
      account.passwordResetRequired ||
      !Number.isSafeInteger(account.credentialVersion) ||
      account.credentialVersion !== actor.account.credentialVersion
    )
      throw new UnauthorizedException('Account changed; authenticate again');
    const session = await manager.findOne(TokenRecordEntity, {
      where: { id: actor.session.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !session ||
      session.accountId !== account.id ||
      session.tokenHash !== actor.session.tokenHash ||
      session.type !== 'portal_session' ||
      session.clientId !== PORTAL_CLIENT_ID ||
      session.status !== 'active' ||
      !this.unexpired(session.expiresAt) ||
      session.metadataJson?.credentialVersion !== account.credentialVersion
    )
      throw new UnauthorizedException('Invalid or expired portal session');
    if (account.isSuperAdmin) {
      const adminSessionId = session.metadataJson?.adminSessionId;
      if (
        typeof adminSessionId !== 'string' ||
        adminSessionId !== actor.session.metadataJson?.adminSessionId
      )
        throw new UnauthorizedException('Admin OTP is required');
      const admin = await manager.findOne(AdminSessionEntity, {
        where: { id: adminSessionId },
        loadEagerRelations: false,
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !admin ||
        admin.accountId !== account.id ||
        admin.revokedAt !== null ||
        admin.credentialVersion !== account.credentialVersion ||
        !this.unexpired(admin.idleExpiresAt) ||
        !this.unexpired(admin.absoluteExpiresAt)
      )
        throw new UnauthorizedException(
          'Admin OTP session is invalid or expired',
        );
    }
    const stamp = session.metadataJson?.authenticatedAt;
    const at = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
    if (
      recent &&
      (!Number.isFinite(at) ||
        Date.now() < at ||
        Date.now() - at > RECENT_AUTH_MS)
    )
      throw new ForbiddenException({
        code: 'reauthentication_required',
        message: 'Authenticate again before changing your account',
      });
    return account;
  }

  private unexpired(value: Date): boolean {
    return value instanceof Date && value.getTime() > Date.now();
  }

  private identities(manager: EntityManager, accountId: string) {
    return manager.find(SocialIdentityEntity, {
      where: { accountId },
      order: { id: 'ASC' },
    });
  }

  private hasLocalCredentials(account: AccountEntity): boolean {
    return Boolean(account.loginId && account.passwordHash);
  }

  private async requireCurrentPassword(
    account: AccountEntity,
    password?: string,
  ) {
    if (!this.hasLocalCredentials(account)) return;
    if (
      typeof password !== 'string' ||
      !password ||
      !(await this.passwords.verify(account.passwordHash!, password))
    )
      throw new UnauthorizedException({
        code: 'invalid_current_password',
        message: 'Current password is required or invalid',
      });
  }

  private async isLastActiveAdmin(
    manager: EntityManager,
    account: AccountEntity,
  ) {
    return (
      account.isSuperAdmin &&
      account.status === 'active' &&
      (await manager.countBy(AccountEntity, {
        isSuperAdmin: true,
        status: 'active',
      })) <= 1
    );
  }

  private lastAdminError() {
    return new ConflictException({
      code: 'last_active_superadmin',
      message:
        'Another active superadmin is required; provider reauthentication or manual recovery may be necessary',
    });
  }

  private assertProvider(provider: string) {
    if (!PROVIDERS.includes(provider))
      throw new BadRequestException('Unsupported social provider');
  }

  private assertConfirmation(value: string, expected: string) {
    if (value !== expected)
      throw new BadRequestException({
        code: 'confirmation_required',
        message: `Confirmation must be exactly ${expected}`,
      });
  }

  private providerBlocker(identities: SocialIdentityEntity[]): string | null {
    try {
      this.providerRevocations.prepare(identities);
      return null;
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 409) {
        const response = error.getResponse();
        if (
          response === 'provider_reauthentication_required' ||
          (typeof response === 'object' &&
            ('code' in response
              ? response.code
              : 'message' in response
                ? response.message
                : null) === 'provider_reauthentication_required')
        )
          return 'provider_reauthentication_required';
      }
      if (error instanceof HttpException && error.getStatus() === 503)
        return 'provider_revocation_unavailable';
      throw error;
    }
  }

  private async invalidateSessions(
    manager: EntityManager,
    account: AccountEntity,
  ) {
    await manager.update(AccountEntity, account.id, {
      credentialVersion: account.credentialVersion + 1,
    });
    await this.accounts.revokeAccountSessions(account.id, manager);
  }

  private async deleteAuthAccount(
    manager: EntityManager,
    account: AccountEntity,
    identities: SocialIdentityEntity[],
  ) {
    await this.invalidateSessions(manager, account);
    if (this.permissionWebhooks) {
      const assignments = await manager.find(AccountServicePermissionEntity, {
        where: { accountId: account.id, status: 'active' },
        relations: { service: true, permissionDefinition: true },
      });
      for (const assignment of assignments) {
        await this.permissionWebhooks.enqueue(
          manager,
          assignment.serviceId,
          createPermissionWebhookEvent({
            type: 'permission.updated',
            serviceKey: assignment.service.serviceKey,
            accountId: account.id,
            data: {
              permission: null,
              previousPermission: assignment.permissionDefinition.key,
              status: 'revoked',
              reason: 'revoked',
            },
          }),
        );
      }
    }
    await this.eraseDetachedPersonalData(manager, account, identities);
    await manager.query(
      'UPDATE service_applications SET reviewed_by_account_id = NULL WHERE reviewed_by_account_id = $1',
      [account.id],
    );
    await manager.query(
      'UPDATE account_service_permissions SET granted_by_account_id = NULL WHERE granted_by_account_id = $1',
      [account.id],
    );
    await manager.query(
      'DELETE FROM service_applications WHERE account_id = $1',
      [account.id],
    );
    await manager.delete(AccountServicePermissionEntity, {
      accountId: account.id,
    });
    await manager.query(
      `DELETE FROM token_records WHERE account_id = $1
       OR metadata_json->>'expectedAccountId' = $1::text`,
      [account.id],
    );
    await manager.query(
      `DELETE FROM notification_idempotency_keys WHERE response_json->>'notificationId' IN
       (SELECT id::text FROM notifications WHERE account_id = $1)`,
      [account.id],
    );
    // Production migrations cascade MFA, admin sessions, identities, notification
    // devices/subscriptions/messages/deliveries/attempts and account policy consents.
    await manager.delete(AccountEntity, { id: account.id });
  }

  private async eraseDetachedPersonalData(
    manager: EntityManager,
    account: AccountEntity,
    identities: SocialIdentityEntity[],
  ) {
    const sessions = await manager.find(TokenRecordEntity, {
      where: { accountId: account.id, type: 'portal_session' },
    });
    const emailContexts = sessions.map((session) =>
      hashSecret(
        JSON.stringify([
          'account_email_change',
          account.id,
          session.tokenHash,
          session.metadataJson?.credentialVersion,
        ]),
      ),
    );
    const transactionResult: unknown = await manager.query(
      `DELETE FROM social_login_transactions tx
         WHERE tx.data_json->>'targetAccountId' = $1
            OR tx.data_json->>'expectedAccountId' = $1
            OR tx.data_json->>'sessionAccountId' = $1
            OR LOWER(BTRIM(tx.data_json->>'email')) = $2
            OR LOWER(BTRIM(tx.data_json->'profile'->>'email')) = $2
            OR EXISTS (
              SELECT 1 FROM jsonb_to_recordset($3::jsonb)
                AS identity(provider text, "providerClientId" text, subject text)
              WHERE tx.provider = identity.provider
                AND tx.data_json->>'providerClientId' = identity."providerClientId"
                AND tx.data_json->'profile'->>'subject' = identity.subject
            ) RETURNING data_json`,
      [
        account.id,
        account.email.trim().toLowerCase(),
        JSON.stringify(
          identities.map(({ provider, providerClientId, subject }) => ({
            provider,
            providerClientId,
            subject,
          })),
        ),
      ],
    );
    // Postgres DELETE RETURNING uses [rows, affectedCount] in TypeORM.
    const transactions = (
      Array.isArray(transactionResult) && Array.isArray(transactionResult[0])
        ? transactionResult[0]
        : transactionResult
    ) as Array<{ data_json: { emailVerificationId?: string } }>;
    await manager.query(
      `DELETE FROM email_verifications WHERE LOWER(BTRIM(email)) = $1
       OR id::text = ANY($2::text[]) OR context_hash = ANY($3::text[])`,
      [
        account.email.trim().toLowerCase(),
        transactions.flatMap((tx) =>
          tx.data_json.emailVerificationId
            ? [tx.data_json.emailVerificationId]
            : [],
        ),
        emailContexts,
      ],
    );
    await manager.query(
      'DELETE FROM admin_bootstrap_challenges WHERE LOWER(BTRIM(email)) = $1 OR login_id = $2',
      [account.email.trim().toLowerCase(), account.loginId],
    );

    const ownedResources: Array<{ id: string }> = await manager.query(
      `SELECT id::text FROM admin_sessions WHERE account_id = $1
       UNION ALL SELECT id::text FROM account_service_permissions WHERE account_id = $1
       UNION ALL SELECT id::text FROM service_applications WHERE account_id = $1
       UNION ALL SELECT id::text FROM notification_devices WHERE account_id = $1
       UNION ALL SELECT id::text FROM notification_subscriptions WHERE account_id = $1
       UNION ALL SELECT id::text FROM notifications WHERE account_id = $1`,
      [account.id],
    );
    const personalTargetIds = [
      account.id,
      ...ownedResources.map(({ id }) => id),
      ...identities.map(({ id }) => id),
    ];
    const audits: AuditLogEntity[] = await manager.query(
      `SELECT id, actor_account_id AS "actorAccountId", target_type AS "targetType",
         target_id AS "targetId", before_json AS "beforeJson", after_json AS "afterJson"
       FROM audit_logs WHERE actor_account_id::text = $1 OR target_id = ANY($3::text[])
         OR STRPOS(COALESCE(before_json::text, '') || COALESCE(after_json::text, ''), $1::text) > 0
         OR STRPOS(LOWER(COALESCE(before_json::text, '') || COALESCE(after_json::text, '')), $2) > 0
       ORDER BY id FOR UPDATE`,
      [account.id, account.email.trim().toLowerCase(), personalTargetIds],
    );
    for (const audit of audits) {
      const ownSnapshot =
        audit.targetId !== null && personalTargetIds.includes(audit.targetId);
      await manager.query(
        `UPDATE audit_logs SET
           actor_account_id = CASE WHEN actor_account_id::text = $2 THEN NULL ELSE actor_account_id END,
           target_id = CASE WHEN target_id = ANY($5::text[]) THEN NULL ELSE target_id END,
           before_json = $3::jsonb, after_json = $4::jsonb,
           ip_address = NULL, user_agent = NULL WHERE id = $1`,
        [
          audit.id,
          account.id,
          ownSnapshot
            ? null
            : JSON.stringify(this.anonymizeJson(audit.beforeJson, account)),
          ownSnapshot
            ? null
            : JSON.stringify(this.anonymizeJson(audit.afterJson, account)),
          personalTargetIds,
        ],
      );
    }

    const requests: ServiceOnboardingRequestEntity[] = await manager.query(
      `SELECT id, requester_email AS "requesterEmail", decided_by_account_id AS "decidedByAccountId",
         requested_spec_json AS "requestedSpecJson", approved_snapshot_json AS "approvedSnapshotJson",
         decision_reason AS "decisionReason"
       FROM service_onboarding_requests WHERE decided_by_account_id = $1
         OR LOWER(BTRIM(requester_email)) = $2
         OR STRPOS(requested_spec_json::text || COALESCE(approved_snapshot_json::text, ''), $1::text) > 0
         OR STRPOS(LOWER(requested_spec_json::text || COALESCE(approved_snapshot_json::text, '')), $2) > 0
       ORDER BY id FOR UPDATE`,
      [account.id, account.email.trim().toLowerCase()],
    );
    for (const onboarding of requests) {
      const owned =
        onboarding.requesterEmail?.trim().toLowerCase() ===
        account.email.trim().toLowerCase();
      const requestedSpecJson = this.anonymizeJson(
        onboarding.requestedSpecJson,
        account,
      )!;
      const approvedSnapshotJson = this.anonymizeJson(
        onboarding.approvedSnapshotJson,
        account,
      );
      if (owned) {
        for (const snapshot of [requestedSpecJson, approvedSnapshotJson]) {
          if (!snapshot) continue;
          delete snapshot.requesterName;
          delete snapshot.requesterEmail;
        }
      }
      await manager.query(
        `UPDATE service_onboarding_requests SET
           decided_by_account_id = CASE WHEN decided_by_account_id = $2 THEN NULL ELSE decided_by_account_id END,
           requester_name = CASE WHEN $3 THEN NULL ELSE requester_name END,
           requester_email = CASE WHEN $3 THEN NULL ELSE requester_email END,
           request_ip = CASE WHEN $3 THEN NULL ELSE request_ip END,
           requested_spec_json = $4::jsonb, approved_snapshot_json = $5::jsonb,
           decision_reason = $6 WHERE id = $1`,
        [
          onboarding.id,
          account.id,
          owned,
          JSON.stringify(requestedSpecJson),
          JSON.stringify(approvedSnapshotJson),
          this.anonymizeText(onboarding.decisionReason, account),
        ],
      );
    }
  }

  private anonymizeJson(
    value: Record<string, unknown> | null,
    account: AccountEntity,
  ): Record<string, unknown> | null {
    const redact = (item: unknown): unknown => {
      if (typeof item === 'string') return this.anonymizeText(item, account);
      if (Array.isArray(item)) return item.map(redact);
      if (item && typeof item === 'object')
        return Object.fromEntries(
          Object.entries(item).map(([key, child]) => [key, redact(child)]),
        );
      return item;
    };
    return redact(value) as Record<string, unknown> | null;
  }

  private anonymizeText(
    value: string | null,
    account: AccountEntity,
  ): string | null {
    if (value === null) return null;
    if (
      [account.id, account.email, account.loginId, account.name].includes(value)
    )
      return null;
    for (const personal of [account.id, account.email, account.loginId]) {
      if (personal) value = value.replaceAll(personal, '[withdrawn]');
    }
    return value;
  }
}
