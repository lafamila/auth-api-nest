import { AppConfigService } from '../config/app-config.service';
import { AccountServicePermissionEntity } from '../database/entities/account-service-permission.entity';
import { AccountEntity } from '../database/entities/account.entity';
import { OidcClientEntity } from '../database/entities/oidc-client.entity';
import { ServicePermissionDefinitionEntity } from '../database/entities/service-permission-definition.entity';
import { AccountPermissionsService } from '../domain/account-permissions/account-permissions.service';
import { AccountsService } from '../domain/accounts/accounts.service';
import { OidcClientsService } from '../domain/oidc-clients/oidc-clients.service';
import { OAuthError } from './oauth-error';
import { OidcController } from './oidc.controller';
import { TokenService } from './token.service';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  AUTHENTICATION_METHOD_CLAIM,
  KAKAO_GAME_DENIED_MESSAGE,
} from './authentication-method';
import { NotFoundException } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthorizeFlowService } from './authorize-flow.service';
import { PublicSiteService } from '../public-site/public-site.service';
import { ConfigService } from '@nestjs/config';
import { AuthenticationMethod } from './authentication-method';

describe('OidcController refresh grant permissions', () => {
  const account = {
    id: 'account-1',
    status: 'active',
    passwordResetRequired: false,
    credentialVersion: 3,
  } as AccountEntity;
  const client = {
    clientId: 'game-platform-api',
    status: 'active',
    serviceId: 'service-game',
    service: {
      id: 'service-game',
      serviceKey: 'game-platform',
      status: 'active',
      category: 'other',
    },
  } as OidcClientEntity;

  it('passes the authorization nonce into the initial ID token issuance', async () => {
    const currentPermission = {
      permissionDefinition: {
        key: 'superadmin',
      } as ServicePermissionDefinitionEntity,
    } as AccountServicePermissionEntity;
    const { controller, codes, tokens } = setup(currentPermission);
    const verifier = 'a'.repeat(43);
    const storedCode = {
      accountId: account.id,
      clientId: client.clientId,
      redirectUri: 'xyz.lafamila.not:/oauth/callback',
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
      scope: 'openid profile email service.permission',
      nonce: 'appauth-generated-nonce',
      credentialVersion: 3,
      authenticationMethod: 'google',
      expiresAt: new Date(Date.now() + 60_000),
    };
    codes.findActive.mockResolvedValue(storedCode);
    codes.consume.mockResolvedValue(storedCode);

    await controller.token({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: 'authorization-code',
      redirect_uri: 'xyz.lafamila.not:/oauth/callback',
      code_verifier: verifier,
    });

    expect(tokens.issueTokens).toHaveBeenCalledWith(
      account,
      client,
      currentPermission,
      undefined,
      'appauth-generated-nonce',
      expect.anything(),
      'google',
    );
  });

  it('mints the refreshed access token from the current changed permission', async () => {
    const currentPermission = {
      permissionDefinition: {
        key: 'admin',
      } as ServicePermissionDefinitionEntity,
    } as AccountServicePermissionEntity;
    const { controller, events, manager, tokens, permissions } =
      setup(currentPermission);

    await expect(
      controller.token({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: 'stored-refresh-token',
      }),
    ).resolves.toEqual({ access_token: 'new-access-token' });

    expect(
      permissions.findActiveOrCreateVisitorForFirstLogin,
    ).toHaveBeenCalledWith(account.id, client.serviceId);
    expect(tokens.issueTokens).toHaveBeenCalledWith(
      account,
      client,
      currentPermission,
      'refresh-family',
      undefined,
      manager,
      'google',
    );
    expect(events).toEqual(['account-lock', 'refresh-consume', 'token-issue']);
  });

  it('refuses refresh when the service permission has been revoked', async () => {
    const { controller, tokens } = setup(null);

    await expect(
      controller.token({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: 'stored-refresh-token',
      }),
    ).rejects.toMatchObject<Partial<OAuthError>>({
      error: 'access_denied',
      statusCode: 403,
    });
    expect(tokens.issueTokens).not.toHaveBeenCalled();
  });

  it('rejects a stale authorization code after locking the account', async () => {
    const currentPermission = {
      permissionDefinition: { key: 'admin' },
    } as AccountServicePermissionEntity;
    const { controller, codes, tokens } = setup(currentPermission);
    const verifier = 'a'.repeat(43);
    const storedCode = {
      accountId: account.id,
      clientId: client.clientId,
      redirectUri: 'xyz.lafamila.not:/oauth/callback',
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256' as const,
      scope: 'openid',
      credentialVersion: 2,
      expiresAt: new Date(Date.now() + 60_000),
    };
    codes.findActive.mockResolvedValue(storedCode);
    codes.consume.mockResolvedValue(storedCode);
    codes.isCurrentCredential.mockReturnValue(false);

    await expect(
      controller.token({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        code: 'authorization-code',
        redirect_uri: storedCode.redirectUri,
        code_verifier: verifier,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(tokens.issueTokens).not.toHaveBeenCalled();
  });

  it('revokes a stale refresh family without inserting a successor', async () => {
    const currentPermission = {
      permissionDefinition: { key: 'admin' },
    } as AccountServicePermissionEntity;
    const { controller, manager, tokens } = setup(currentPermission);
    tokens.isCurrentCredential.mockReturnValue(false);

    await expect(
      controller.token({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: 'stored-refresh-token',
      }),
    ).rejects.toThrow('Invalid refresh token');

    expect(tokens.revokeFamily).toHaveBeenCalledWith('refresh-family', manager);
    expect(tokens.issueTokens).not.toHaveBeenCalled();
  });

  it('commits refresh-family reuse handling before returning its error', async () => {
    const currentPermission = {
      permissionDefinition: { key: 'admin' },
    } as AccountServicePermissionEntity;
    const { controller, transactionState, tokens } = setup(currentPermission);
    tokens.consumeRefreshTokenForRotation.mockResolvedValue({ kind: 'reuse' });

    await expect(
      controller.token({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: 'reused-refresh-token',
      }),
    ).rejects.toThrow('Refresh token reuse detected');

    expect(transactionState.commits).toBe(1);
    expect(tokens.issueTokens).not.toHaveBeenCalled();
  });

  it.each(['kakao', 'legacy'] as const)(
    'commits game %s refresh family revocation without issuing tokens',
    async (method) => {
      const f = setup(
        {
          permissionDefinition: { key: 'member' },
        } as AccountServicePermissionEntity,
        { category: 'game', method },
      );
      await expect(
        f.controller.token({
          grant_type: 'refresh_token',
          client_id: client.clientId,
          refresh_token: 'original-refresh',
        }),
      ).rejects.toMatchObject({
        error: 'access_denied',
        code:
          method === 'kakao'
            ? 'AUTHENTICATION_METHOD_NOT_ALLOWED'
            : 'AUTHENTICATION_METHOD_REAUTHENTICATION_REQUIRED',
        ...(method === 'kakao'
          ? { errorDescription: KAKAO_GAME_DENIED_MESSAGE }
          : {}),
      });
      expect(f.tokens.revokeFamily).toHaveBeenCalledWith(
        'refresh-family',
        f.manager,
      );
      expect(f.tokens.issueTokens).not.toHaveBeenCalled();
      expect(f.transactionState.commits).toBe(1);
    },
  );

  it('does not accept caller method fields to elevate a Kakao refresh token', async () => {
    const f = setup(
      {
        permissionDefinition: { key: 'member' },
      } as AccountServicePermissionEntity,
      { category: 'game', method: 'kakao' },
    );
    await expect(
      f.controller.token(
        {
          grant_type: 'refresh_token',
          client_id: client.clientId,
          refresh_token: 'original-refresh',
          authenticationMethod: 'local',
        } as never,
        'Bearer local',
      ),
    ).rejects.toMatchObject({ error: 'access_denied' });
    expect(f.tokens.issueTokens).not.toHaveBeenCalled();
  });

  it.each(['kakao', 'legacy'] as const)(
    'rechecks game policy at code exchange for %s provenance',
    async (method) => {
      const f = setup(
        {
          permissionDefinition: { key: 'member' },
        } as AccountServicePermissionEntity,
        { category: 'game' },
      );
      const verifier = 'a'.repeat(43);
      const stored = {
        accountId: account.id,
        clientId: client.clientId,
        redirectUri: 'https://play.example.test/callback',
        codeChallenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        authenticationMethod: method,
      };
      f.codes.findActive.mockResolvedValue(stored);
      f.codes.consume.mockResolvedValue(stored);
      await expect(
        f.controller.token({
          grant_type: 'authorization_code',
          client_id: client.clientId,
          code: 'single-use',
          redirect_uri: stored.redirectUri,
          code_verifier: verifier,
        }),
      ).rejects.toMatchObject({ error: 'access_denied' });
      expect(f.tokens.issueTokens).not.toHaveBeenCalled();
      expect(f.transactionState.commits).toBe(1);
    },
  );

  it.each(['kakao', 'legacy', 'local', 'google'] as const)(
    'userinfo checks the current game category and signed %s provenance',
    async (method) => {
      const f = setup(
        {
          permissionDefinition: { key: 'member' },
        } as AccountServicePermissionEntity,
        { category: 'game' },
      );
      f.tokens.verifyAccessToken.mockReturnValue({
        sub: account.id,
        aud: 'service:game-platform',
        [AUTHENTICATION_METHOD_CLAIM]: method,
        'https://lafamila.xyz/claims/service': { key: 'game-platform' },
      });
      if (method === 'kakao' || method === 'legacy')
        await expect(
          f.controller.userinfo('Bearer verified-token'),
        ).rejects.toMatchObject({ error: 'access_denied' });
      else
        expect(
          (await f.controller.userinfo('Bearer verified-token'))[
            AUTHENTICATION_METHOD_CLAIM
          ],
        ).toBe(method);
    },
  );

  it('userinfo rejects withdrawn accounts rather than returning stale token profile data', async () => {
    const f = setup(null);
    f.tokens.verifyAccessToken.mockReturnValue({ sub: account.id });
    f.accounts.findById.mockRejectedValue(new NotFoundException());
    await expect(
      f.controller.userinfo('Bearer previously-valid'),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('treats a withdrawn refresh-token holder as invalid credentials rather than a public 404', async () => {
    const f = setup(null);
    f.accounts.findById.mockRejectedValue(new NotFoundException());
    await expect(
      f.controller.token({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: 'old-refresh',
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.tokens.consumeRefreshTokenForRotation).not.toHaveBeenCalled();
  });

  function setup(
    currentPermission: AccountServicePermissionEntity | null,
    options: { category?: string; method?: string } = {},
  ) {
    const events: string[] = [];
    const transactionState = { commits: 0 };
    const permissions = {
      findActiveOrCreateVisitorForFirstLogin: jest
        .fn()
        .mockResolvedValue(currentPermission),
    };
    const accounts = {
      findById: jest.fn().mockResolvedValue(account),
    };
    const clients = {
      findByClientId: jest.fn().mockResolvedValue({
        ...client,
        service: { ...client.service, category: options.category ?? 'other' },
      }),
      validateClientSecret: jest.fn().mockResolvedValue(undefined),
    };
    const tokens = {
      getRefreshTokenAccountId: jest.fn().mockResolvedValue({
        accountId: account.id,
        clientId: client.clientId,
      }),
      consumeRefreshTokenForRotation: jest.fn().mockImplementation(async () => {
        events.push('refresh-consume');
        return {
          kind: 'consumed',
          refresh: {
            accountId: account.id,
            clientId: client.clientId,
            familyId: 'refresh-family',
            credentialVersion: 3,
            authenticationMethod: options.method ?? 'google',
          },
        };
      }),
      isCurrentCredential: jest.fn().mockReturnValue(true),
      revokeFamily: jest.fn().mockResolvedValue(undefined),
      issueTokens: jest.fn().mockImplementation(async () => {
        events.push('token-issue');
        return { access_token: 'new-access-token' };
      }),
      verifyAccessToken: jest.fn(),
    };
    const codes = {
      findActive: jest.fn(),
      consume: jest.fn(),
      isCurrentCredential: jest.fn().mockReturnValue(true),
    };
    const accountRepository = {
      findOne: jest.fn().mockImplementation(async () => {
        events.push('account-lock');
        return account;
      }),
    };
    const permissionRepository = {
      findOne: jest.fn().mockResolvedValue(currentPermission),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity === AccountEntity ? accountRepository : permissionRepository,
      ),
    } as unknown as EntityManager;
    const dataSource = {
      manager,
      getRepository: jest.fn().mockReturnValue({
        findOneBy: async () => ({
          id: client.serviceId,
          category: options.category ?? 'other',
        }),
      }),
      transaction: jest.fn(
        async (callback: (transaction: EntityManager) => Promise<unknown>) => {
          const result = await callback(manager);
          transactionState.commits += 1;
          return result;
        },
      ),
    } as unknown as DataSource;
    const controller = new OidcController(
      {} as AppConfigService,
      permissions as unknown as AccountPermissionsService,
      accounts as unknown as AccountsService,
      clients as unknown as OidcClientsService,
      codes as never,
      {} as never,
      {} as never,
      tokens as unknown as TokenService,
      {} as never,
      {} as never,
      dataSource,
    );
    return {
      controller,
      events,
      manager,
      permissions,
      transactionState,
      codes,
      tokens,
      accounts,
    };
  }
});

describe('OidcController SSO game provenance', () => {
  function setup(method: AuthenticationMethod, category = 'game') {
    const account = { id: 'account', status: 'active', credentialVersion: 0 };
    const client = {
      clientId: 'registered-client',
      serviceId: 'service',
      status: 'active',
      clientType: 'public',
      service: { category, status: 'active' },
      redirectUris: ['https://play.example.test/callback'],
      requirePkce: true,
    };
    const codes = { create: jest.fn().mockResolvedValue('single-use-code') };
    const accounts = { findById: jest.fn().mockResolvedValue(account) };
    const clients = { findByClientId: async () => client };
    const permissions = {
      findActiveOrCreateVisitorForFirstLogin: jest
        .fn()
        .mockResolvedValue({ status: 'active' }),
    };
    const publicSite = new PublicSiteService(new ConfigService());
    const decorate = jest.spyOn(publicSite, 'decorate');
    const flow = new AuthorizeFlowService(
      accounts as never,
      clients as never,
      permissions as never,
      codes as never,
      undefined,
      publicSite,
    );
    const hosted = {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'transaction', browserNonce: 'binding' }),
      cookieName: () => 'login-binding',
    };
    const sso = {
      context: jest.fn().mockResolvedValue({
        accountId: account.id,
        authenticationMethod: method,
        credentialVersion: account.credentialVersion,
      }),
    };
    const portal = { signOutKakao: jest.fn() };
    const controller = new OidcController(
      {} as never,
      permissions as never,
      accounts as never,
      clients as never,
      codes as never,
      flow,
      {} as never,
      {} as never,
      hosted as never,
      sso as never,
      {} as never,
      portal as never,
    );
    const response = {
      cookie: jest.fn(),
      set: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      redirect: jest.fn(),
    };
    const request = {
      query: { authentication_method: 'local' },
      headers: { 'x-authentication-method': 'local' },
    } as unknown as Request;
    const authorize = (prompt?: string) =>
      controller.authorize(
        client.clientId,
        client.redirectUris[0],
        'code',
        'openid',
        'original-state',
        'nonce',
        'challenge',
        'S256',
        prompt,
        request,
        response as unknown as Response,
      );
    return {
      authorize,
      accounts,
      codes,
      permissions,
      hosted,
      portal,
      response,
      sso,
      decorate,
    };
  }

  it.each([
    ['local', 'game'],
    ['google', 'game'],
    ['naver', 'game'],
    ['kakao', 'productivity'],
    ['legacy', 'productivity'],
  ] as const)(
    'rejects a credential version bump after validating %s SSO for %s',
    async (method, category) => {
      const f = setup(method, category);
      f.accounts.findById.mockResolvedValue({
        id: 'account',
        status: 'active',
        credentialVersion: 1,
      });

      await f.authorize();

      expect(f.response.status).toHaveBeenCalledWith(403);
      expect(f.response.json).toHaveBeenCalledWith({
        error: 'access_denied',
        error_description: 'Account credential state has changed',
      });
      expect(
        f.permissions.findActiveOrCreateVisitorForFirstLogin,
      ).not.toHaveBeenCalled();
      expect(f.codes.create).not.toHaveBeenCalled();
      expect(f.response.redirect).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'select_account'])(
    'forces fresh login for unknown/stripped legacy provenance (%s)',
    async (prompt) => {
      const f = setup('legacy');
      await f.authorize(prompt);
      expect(f.codes.create).not.toHaveBeenCalled();
      expect(f.hosted.create).toHaveBeenCalledWith(
        expect.objectContaining({ sessionAccountId: 'account' }),
      );
      expect(f.response.send).toHaveBeenCalledWith(
        expect.stringContaining('name="password"'),
      );
      expect(f.response.send).toHaveBeenCalledWith(
        expect.not.stringContaining('value="current"'),
      );
      expect(f.portal.signOutKakao).not.toHaveBeenCalled();
    },
  );

  it('denies Kakao SSO with the exact message, signs out matching context, and decorates before CSP', async () => {
    const f = setup('kakao');
    f.response.set.mockImplementation(() => {
      expect(f.decorate).toHaveBeenCalled();
      return f.response;
    });
    await f.authorize();
    expect(f.codes.create).not.toHaveBeenCalled();
    expect(f.portal.signOutKakao).toHaveBeenCalled();
    expect(f.response.send).toHaveBeenCalledWith(
      expect.stringContaining(KAKAO_GAME_DENIED_MESSAGE),
    );
    expect(f.response.send).toHaveBeenCalledWith(
      expect.stringContaining('content="3;url='),
    );
    expect(f.response.send).toHaveBeenCalledWith(
      expect.stringContaining('/public/assets/site.css'),
    );
    expect(f.response.redirect).not.toHaveBeenCalled();
  });

  it.each(['local', 'google', 'naver'] as const)(
    'keeps trusted %s SSO eligible for games',
    async (method) => {
      const f = setup(method);
      await f.authorize();
      expect(f.codes.create).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticationMethod: method,
          nonce: 'nonce',
        }),
      );
      expect(f.response.redirect).toHaveBeenCalledWith(
        expect.stringContaining('code=single-use-code&state=original-state'),
      );
      expect(f.portal.signOutKakao).not.toHaveBeenCalled();
    },
  );

  it('does not globally disable Kakao for non-game SSO', async () => {
    const f = setup('kakao', 'productivity');
    await f.authorize();
    expect(f.codes.create).toHaveBeenCalledWith(
      expect.objectContaining({ authenticationMethod: 'kakao' }),
    );
  });
});
