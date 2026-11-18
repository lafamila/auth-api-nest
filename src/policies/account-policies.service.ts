import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AccountPolicyConsentEntity } from '../database/entities/account-policy-consent.entity';
import { AccountEntity } from '../database/entities/account.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { PublicSiteService } from '../public-site/public-site.service';
import { PortalActor } from '../portal/portal.types';
import { PolicyAcceptanceDto } from './policy-acceptance.dto';

@Injectable()
export class AccountPoliciesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(AccountPolicyConsentEntity)
    private readonly consents: Repository<AccountPolicyConsentEntity>,
    private readonly site: PublicSiteService,
  ) {}

  current() {
    const versions = this.site.policyVersions();
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          versions,
          metadata: this.site.publicMetadata(),
          documents: {
            terms: this.site.render('terms'),
            privacy: this.site.render('privacy'),
          },
        }),
      )
      .digest('hex');
    return {
      ...versions,
      policyDigest: digest,
      termsUrl: '/terms',
      privacyUrl: '/privacy',
    };
  }

  validate(input: PolicyAcceptanceDto): void {
    const current = this.current();
    if (
      input?.termsAccepted !== true ||
      input?.privacyAccepted !== true ||
      input.termsVersion !== current.termsVersion ||
      input.privacyVersion !== current.privacyVersion ||
      input.policyDigest !== current.policyDigest
    ) {
      throw new BadRequestException({
        code: 'policy_acceptance_required',
        message: '현재 이용약관과 개인정보처리방침을 확인하고 동의해 주세요',
      });
    }
  }

  async record(
    manager: EntityManager,
    accountId: string,
    input: PolicyAcceptanceDto,
    source: AccountPolicyConsentEntity['source'],
  ): Promise<void> {
    this.validate(input);
    await manager
      .getRepository(AccountPolicyConsentEntity)
      .createQueryBuilder()
      .insert()
      .values({
        accountId,
        termsVersion: input.termsVersion,
        privacyVersion: input.privacyVersion,
        policyDigest: input.policyDigest,
        source,
      })
      .orIgnore()
      .execute();
  }

  async status(actor: PortalActor) {
    const current = this.current();
    const consent = await this.consents.findOneBy({
      accountId: actor.account.id,
      termsVersion: current.termsVersion,
      privacyVersion: current.privacyVersion,
      policyDigest: current.policyDigest,
    });
    return {
      ...current,
      accepted: Boolean(consent),
      acceptedAt: consent?.acceptedAt ?? null,
    };
  }

  async accept(actor: PortalActor, input: PolicyAcceptanceDto) {
    this.validate(input);
    await this.dataSource.transaction(async (manager) => {
      const account = await manager.findOne(AccountEntity, {
        where: { id: actor.account.id },
        lock: { mode: 'pessimistic_write' },
      });
      const session = await manager.findOne(TokenRecordEntity, {
        where: {
          id: actor.session.id,
          accountId: actor.account.id,
          type: 'portal_session',
          status: 'active',
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !account ||
        account.status !== 'active' ||
        account.passwordResetRequired ||
        account.credentialVersion !== actor.account.credentialVersion ||
        !session ||
        session.expiresAt.getTime() <= Date.now()
      )
        throw new UnauthorizedException('Login is required');
      await this.record(manager, account.id, input, 'portal');
    });
    return this.status(actor);
  }
}
