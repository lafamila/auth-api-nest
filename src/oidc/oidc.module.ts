import { Module } from '@nestjs/common';
import { AccountsModule } from '../domain/accounts/accounts.module';
import { AccountPermissionsModule } from '../domain/account-permissions/account-permissions.module';
import { AppConfigModule } from '../config/app-config.module';
import { OidcClientsModule } from '../domain/oidc-clients/oidc-clients.module';
import { OidcController } from './oidc.controller';
import { LoginController } from './login.controller';
import { AuthorizationCodeService } from './authorization-code.service';
import { AuthorizeFlowService } from './authorize-flow.service';
import { OidcProviderAdapterService } from './oidc-provider-adapter.service';
import { SigningKeyService } from './signing-key.service';
import { TokenService } from './token.service';

@Module({
  imports: [AppConfigModule, AccountsModule, OidcClientsModule, AccountPermissionsModule],
  controllers: [OidcController, LoginController],
  providers: [
    AuthorizationCodeService,
    AuthorizeFlowService,
    OidcProviderAdapterService,
    SigningKeyService,
    TokenService,
  ],
  exports: [TokenService, SigningKeyService],
})
export class OidcModule {}
