import { BadRequestException } from '@nestjs/common';
import { OidcClientType } from '../../database/entities/oidc-client.entity';

export function assertPublicClientPkce(
  clientType: OidcClientType,
  requirePkce: boolean,
): void {
  if (clientType === 'public' && !requirePkce) {
    throw new BadRequestException('Public OIDC clients require S256 PKCE');
  }
}
