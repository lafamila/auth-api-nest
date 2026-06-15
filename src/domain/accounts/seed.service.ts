import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { AccountsService } from './accounts.service';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly accounts: AccountsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const seed = this.config.seedAdmin;
    if (!seed.enabled) {
      return;
    }
    const existing = await this.accounts.findByLoginId(seed.loginId);
    if (existing) {
      return;
    }
    await this.accounts.create({
      loginId: seed.loginId,
      name: seed.name,
      email: seed.email,
      password: seed.password,
      isSuperAdmin: true,
    });
    this.logger.log(`Seeded super admin account: ${seed.loginId}`);
  }
}
