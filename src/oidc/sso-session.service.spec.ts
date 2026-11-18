import { UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { hashToken } from '../common/crypto/token-hash';
import { AppConfigService } from '../config/app-config.service';
import { AccountEntity } from '../database/entities/account.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';
import { SsoSessionService } from './sso-session.service';

const MAX_AGE = 12 * 60 * 60 * 1000;
const ACTIVE_ACCOUNT = {
  id: 'account-1',
  status: 'active',
  passwordResetRequired: false,
  credentialVersion: 0,
} as AccountEntity & { credentialVersion: number };

describe('SsoSessionService', () => {
  it('locks fresh account state, stores only the token hash, and sets cookies after commit', async () => {
    const harness = createHarness({ databaseAccount: ACTIVE_ACCOUNT });
    const input = {
      ...ACTIVE_ACCOUNT,
      credentialVersion: undefined,
    } as unknown as AccountEntity;

    await harness.service.create(input, harness.response);

    expect(harness.transactionAccounts.findOne).toHaveBeenCalledWith({
      where: { id: ACTIVE_ACCOUNT.id },
      lock: { mode: 'pessimistic_write' },
    });
    expect(harness.transactionTokens.insert).toHaveBeenCalledTimes(1);
    const inserted = harness.transactionTokens.insert.mock.calls[0][0] as {
      tokenHash: string;
      type: string;
      clientId: string;
      metadataJson: Record<string, unknown>;
      expiresAt: Date;
    };
    const sessionCookie = harness.response.cookie.mock.calls.find(
      ([name]) => name === 'tas_session_id',
    );
    const rawToken = sessionCookie?.[1] as string;
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inserted).toEqual(
      expect.objectContaining({
        tokenHash: hashToken(rawToken),
        type: 'sso_session',
        clientId: 'auth-sso',
        metadataJson: { credentialVersion: 0, authenticationMethod: 'local' },
      }),
    );
    expect(JSON.stringify(inserted)).not.toContain(rawToken);
    expect(inserted.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + MAX_AGE - 1000,
    );
    expect(harness.response.cookie).toHaveBeenNthCalledWith(
      1,
      'tas_session',
      ACTIVE_ACCOUNT.id,
      cookieOptions(false),
    );
    expect(harness.response.cookie).toHaveBeenNthCalledWith(
      2,
      'tas_session_id',
      rawToken,
      cookieOptions(false),
    );
    expect(harness.cookiesSetBeforeCommit).toBe(false);
  });

  it('uses the authenticated credential version when fresh state still matches', async () => {
    const account = versionedAccount(7);
    const harness = createHarness({ databaseAccount: account });

    await harness.service.create(account, harness.response);

    expect(harness.transactionTokens.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        metadataJson: { credentialVersion: 7, authenticationMethod: 'local' },
      }),
    );
  });

  it.each([null, -1, 1.5])(
    'rejects malformed authenticated credential version %s',
    async (credentialVersion) => {
      const harness = createHarness({ databaseAccount: ACTIVE_ACCOUNT });
      const input = {
        ...ACTIVE_ACCOUNT,
        credentialVersion,
      } as unknown as AccountEntity;

      await expect(
        harness.service.create(input, harness.response),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(harness.transactionAccounts.findOne).not.toHaveBeenCalled();
      expect(harness.transactionTokens.insert).not.toHaveBeenCalled();
      expect(harness.response.cookie).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing', null],
    ['disabled', { ...ACTIVE_ACCOUNT, status: 'disabled' as const }],
    ['reset-required', { ...ACTIVE_ACCOUNT, passwordResetRequired: true }],
    ['newer credential version', versionedAccount(2)],
  ])(
    'rejects creation when fresh account state is %s',
    async (_name, fresh) => {
      const harness = createHarness({ databaseAccount: fresh });

      await expect(
        harness.service.create(versionedAccount(1), harness.response),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(harness.transactionTokens.insert).not.toHaveBeenCalled();
      expect(harness.response.cookie).not.toHaveBeenCalled();
    },
  );

  it('uses secure root-scoped cookies in production', async () => {
    const harness = createHarness({
      databaseAccount: ACTIVE_ACCOUNT,
      nodeEnv: 'production',
    });

    await harness.service.create(ACTIVE_ACCOUNT, harness.response);

    expect(harness.response.cookie).toHaveBeenCalledWith(
      'tas_session',
      ACTIVE_ACCOUNT.id,
      cookieOptions(true),
    );
    expect(harness.response.cookie).toHaveBeenCalledWith(
      'tas_session_id',
      expect.any(String),
      cookieOptions(true),
    );
  });

  it('resolves a valid current opaque session', async () => {
    const rawToken = opaqueToken('a');
    const harness = createHarness({
      account: versionedAccount(3),
      session: sessionRecord(rawToken, { credentialVersion: 3 }),
    });

    await expect(
      harness.service.accountId(signedRequest(ACTIVE_ACCOUNT.id, rawToken)),
    ).resolves.toBe(ACTIVE_ACCOUNT.id);
    expect(harness.tokenRecords.findOne).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(rawToken) },
    });
  });

  it('preserves the authenticated credential version in the SSO context', async () => {
    const rawToken = opaqueToken('v');
    const account = versionedAccount(7);
    const harness = createHarness({
      account,
      session: sessionRecord(rawToken, {
        credentialVersion: 7,
        authenticationMethod: 'google',
      }),
    });

    const context = await harness.service.context(
      signedRequest(ACTIVE_ACCOUNT.id, rawToken),
    );
    account.credentialVersion = 8;

    expect(context).toEqual({
      accountId: ACTIVE_ACCOUNT.id,
      authenticationMethod: 'google',
      credentialVersion: 7,
    });
  });

  it('accepts a signed legacy primary cookie only at credential version zero', async () => {
    const legacy = createHarness({ account: versionedAccount(0) });
    const changed = createHarness({ account: versionedAccount(1) });
    const request = signedRequest(ACTIVE_ACCOUNT.id);

    await expect(legacy.service.accountId(request)).resolves.toBe(
      ACTIVE_ACCOUNT.id,
    );
    await expect(changed.service.accountId(request)).resolves.toBeNull();
    await expect(legacy.service.context(request)).resolves.toEqual({
      accountId: ACTIVE_ACCOUNT.id,
      authenticationMethod: 'legacy',
      credentialVersion: 0,
    });
    expect(legacy.tokenRecords.findOne).not.toHaveBeenCalled();
  });

  it.each(['local', 'google', 'kakao', 'naver', 'legacy'] as const)(
    'returns the persisted %s method, ignoring browser method hints',
    async (method) => {
      const raw = opaqueToken('m');
      const h = createHarness({
        account: ACTIVE_ACCOUNT,
        session: sessionRecord(raw, {
          credentialVersion: 0,
          authenticationMethod: method,
        }),
      });
      const request = signedRequest(ACTIVE_ACCOUNT.id, raw);
      Object.assign(request, {
        query: { authentication_method: 'local' },
        headers: { 'x-authentication-method': 'local' },
      });
      await expect(h.service.context(request)).resolves.toEqual({
        accountId: ACTIVE_ACCOUNT.id,
        authenticationMethod: method,
        credentialVersion: 0,
      });
    },
  );

  it.each([undefined, 'untrusted'])(
    'treats missing or unknown stored provenance as legacy: %s',
    async (method) => {
      const raw = opaqueToken('m');
      const h = createHarness({
        account: ACTIVE_ACCOUNT,
        session: sessionRecord(raw, {
          credentialVersion: 0,
          authenticationMethod: method,
        }),
      });
      expect(
        (await h.service.context(signedRequest(ACTIVE_ACCOUNT.id, raw)))
          ?.authenticationMethod,
      ).toBe('legacy');
      expect(
        (await h.service.context(signedRequest(ACTIVE_ACCOUNT.id)))
          ?.authenticationMethod,
      ).toBe('legacy');
    },
  );

  it.each([
    ['cookie-parser signature failure', false, undefined],
    ['empty signed cookie', '', undefined],
    ['malformed signed cookie', 'not-an-opaque-token', undefined],
    ['unsigned raw cookie', undefined, opaqueToken('u')],
  ])(
    'fails closed without legacy fallback for %s',
    async (_name, signedValue, rawValue) => {
      const harness = createHarness({ account: versionedAccount(0) });
      const request = signedRequest(ACTIVE_ACCOUNT.id) as SessionRequest;
      if (signedValue !== undefined) {
        request.signedCookies.tas_session_id = signedValue;
      }
      if (rawValue !== undefined) {
        request.cookies = { tas_session_id: rawValue };
      }

      await expect(harness.service.accountId(request)).resolves.toBeNull();
      expect(harness.accounts.findOneBy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing row', null],
    ['revoked row', sessionRecord(opaqueToken('r'), {}, { status: 'revoked' })],
    [
      'expired row',
      sessionRecord(opaqueToken('r'), {}, { expiresAt: new Date(0) }),
    ],
    [
      'cross-client row',
      sessionRecord(opaqueToken('r'), {}, { clientId: 'other-client' }),
    ],
    [
      'cross-type row',
      sessionRecord(opaqueToken('r'), {}, { type: 'refresh_token' }),
    ],
    [
      'cross-account row',
      sessionRecord(opaqueToken('r'), {}, { accountId: 'account-2' }),
    ],
    [
      'missing credential metadata',
      sessionRecord(opaqueToken('r'), { credentialVersion: undefined }),
    ],
  ])('rejects an invalid opaque session: %s', async (_name, session) => {
    const rawToken = opaqueToken('r');
    const harness = createHarness({
      account: versionedAccount(0),
      session,
    });

    await expect(
      harness.service.accountId(signedRequest(ACTIVE_ACCOUNT.id, rawToken)),
    ).resolves.toBeNull();
  });

  it.each([
    ['missing', null],
    ['disabled', { ...versionedAccount(2), status: 'disabled' }],
    ['reset-required', { ...versionedAccount(2), passwordResetRequired: true }],
    ['version-mismatched', versionedAccount(3)],
  ])('rejects a %s current account', async (_name, account) => {
    const rawToken = opaqueToken('c');
    const harness = createHarness({
      account: account as AccountEntity | null,
      session: sessionRecord(rawToken, { credentialVersion: 2 }),
    });

    await expect(
      harness.service.accountId(signedRequest(ACTIVE_ACCOUNT.id, rawToken)),
    ).resolves.toBeNull();
  });

  it('revokes only the exact signed auth SSO session and clears both cookies', async () => {
    const rawToken = opaqueToken('l');
    const harness = createHarness();

    await harness.service.clear(
      signedRequest(ACTIVE_ACCOUNT.id, rawToken),
      harness.response,
    );

    expect(harness.tokenRecords.update).toHaveBeenCalledWith(
      {
        tokenHash: hashToken(rawToken),
        type: 'sso_session',
        clientId: 'auth-sso',
        status: 'active',
      },
      { status: 'revoked', usedAt: expect.any(Date) },
    );
    expect(harness.response.clearCookie).toHaveBeenNthCalledWith(
      1,
      'tas_session',
      clearCookieOptions(false),
    );
    expect(harness.response.clearCookie).toHaveBeenNthCalledWith(
      2,
      'tas_session_id',
      clearCookieOptions(false),
    );
  });

  it('revokes a valid signed auxiliary session without a primary cookie', async () => {
    const rawToken = opaqueToken('l');
    const harness = createHarness();
    const request = {
      signedCookies: { tas_session_id: rawToken },
      cookies: {},
    } as unknown as Request;

    await harness.service.clear(request, harness.response);

    expect(harness.tokenRecords.update).toHaveBeenCalledWith(
      {
        tokenHash: hashToken(rawToken),
        type: 'sso_session',
        clientId: 'auth-sso',
        status: 'active',
      },
      { status: 'revoked', usedAt: expect.any(Date) },
    );
    expect(harness.response.clearCookie).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['unsigned auxiliary cookie', undefined, opaqueToken('u')],
    ['malformed signed auxiliary cookie', 'not-an-opaque-token', undefined],
    ['failed auxiliary signature', false, undefined],
  ])('does not revoke an %s', async (_name, signedValue, rawValue) => {
    const harness = createHarness();
    const request = signedRequest(ACTIVE_ACCOUNT.id) as SessionRequest;
    if (signedValue !== undefined) {
      request.signedCookies.tas_session_id = signedValue;
    }
    if (rawValue !== undefined) {
      request.cookies = { tas_session_id: rawValue };
    }

    await harness.service.clear(request, harness.response);

    expect(harness.tokenRecords.update).not.toHaveBeenCalled();
    expect(harness.response.clearCookie).toHaveBeenCalledTimes(2);
  });
});

type SessionRequest = Request & {
  signedCookies: Record<string, string | false | undefined>;
  cookies?: Record<string, unknown>;
};

function createHarness(
  options: {
    account?: AccountEntity | null;
    databaseAccount?: AccountEntity | null;
    session?: TokenRecordEntity | null;
    nodeEnv?: string;
  } = {},
) {
  const accounts = {
    findOneBy: jest.fn().mockResolvedValue(options.account ?? null),
  };
  const tokenRecords = {
    findOne: jest.fn().mockResolvedValue(options.session ?? null),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const transactionAccounts = {
    findOne: jest.fn().mockResolvedValue(options.databaseAccount ?? null),
  };
  const transactionTokens = {
    insert: jest.fn().mockResolvedValue(undefined),
  };
  const manager = {
    getRepository: jest.fn((entity: unknown) =>
      entity === AccountEntity ? transactionAccounts : transactionTokens,
    ),
  } as unknown as EntityManager;
  let committed = false;
  let cookiesSetBeforeCommit = false;
  const dataSource = {
    transaction: jest.fn(
      async (callback: (manager: EntityManager) => unknown) => {
        const result = await callback(manager);
        committed = true;
        return result;
      },
    ),
  } as unknown as DataSource;
  const response = {
    cookie: jest.fn((...args: [string, string, unknown]) => {
      void args;
      if (!committed) cookiesSetBeforeCommit = true;
    }),
    clearCookie: jest.fn((...args: [string, unknown]) => {
      void args;
    }),
  };
  const config = {
    nodeEnv: options.nodeEnv ?? 'test',
  } as AppConfigService;
  const service = new SsoSessionService(
    accounts as unknown as Repository<AccountEntity>,
    tokenRecords as unknown as Repository<TokenRecordEntity>,
    dataSource,
    config,
  );

  return {
    service,
    accounts,
    tokenRecords,
    transactionAccounts,
    transactionTokens,
    response: response as unknown as Response & typeof response,
    get cookiesSetBeforeCommit() {
      return cookiesSetBeforeCommit;
    },
  };
}

function versionedAccount(version: number): AccountEntity {
  return {
    ...ACTIVE_ACCOUNT,
    credentialVersion: version,
  };
}

function opaqueToken(character: string): string {
  return character.repeat(43);
}

function sessionRecord(
  rawToken: string,
  metadataJson: Record<string, unknown> = { credentialVersion: 0 },
  overrides: Partial<TokenRecordEntity> = {},
): TokenRecordEntity {
  return {
    id: 'session-1',
    tokenHash: hashToken(rawToken),
    type: 'sso_session',
    status: 'active',
    familyId: null,
    accountId: ACTIVE_ACCOUNT.id,
    clientId: 'auth-sso',
    serviceId: null,
    metadataJson,
    usedAt: null,
    expiresAt: new Date(Date.now() + MAX_AGE),
    createdAt: new Date(),
    ...overrides,
  };
}

function signedRequest(accountId: string, sessionId?: string): Request {
  return {
    signedCookies: {
      tas_session: accountId,
      ...(sessionId === undefined ? {} : { tas_session_id: sessionId }),
    },
    cookies: {},
  } as unknown as Request;
}

function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    signed: true,
    maxAge: MAX_AGE,
    path: '/',
  };
}

function clearCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  };
}
