import { createRequire } from 'node:module';

type SessionAccount = {
  name: string;
  email: string;
};

type ImportedDraft = {
  serviceKey: string;
  name: string;
  description: string;
  requesterName: string;
  requesterEmail: string;
  permissions: Array<{ key: string; label: string; description: string }>;
  oidcClients: Array<{
    clientId: string;
    clientType: 'public' | 'confidential';
    requirePkce: boolean;
    redirectUris: string;
    postLogoutRedirectUris: string;
    allowedScopes: string;
  }>;
  serviceCredentials: Array<{
    name: string;
    description: string;
    scopes: string;
  }>;
};

type ImportResult = {
  draft: ImportedDraft;
  warnings: string[];
};

type ServiceRequestImportModule = {
  normalizeImportedServiceRequest: (
    value: unknown,
    sessionAccount: SessionAccount,
    options?: { supportedCredentialScopes: Array<{ key: string }> },
  ) => ImportResult;
  parseImportedServiceRequestText: (
    text: string,
    sessionAccount: SessionAccount,
    options?: { supportedCredentialScopes: Array<{ key: string }> },
  ) => ImportResult;
};

const requireFromSpec = createRequire(__filename);
const { normalizeImportedServiceRequest, parseImportedServiceRequestText } =
  requireFromSpec(
    '../public/service-request-import.js',
  ) as ServiceRequestImportModule;

describe('service request import helper', () => {
  const sessionAccount = {
    name: 'Admin Session User',
    email: 'admin-session@lafamila.xyz',
  };
  const importOptions = {
    supportedCredentialScopes: [
      { key: 'account.search' },
      { key: 'permission.read' },
    ],
  };

  it('overrides requester identity from the current session and warns on unknown fields', () => {
    const result = normalizeImportedServiceRequest(
      {
        serviceKey: 'todo',
        name: 'Todo',
        description: 'Task tracker',
        requesterName: 'Untrusted Import User',
        requesterEmail: 'untrusted@example.com',
        permissions: [
          { key: 'member', label: 'Member', description: 'Standard access' },
        ],
        oidcClients: [],
        serviceCredentials: [],
        extraField: 'ignored',
      },
      sessionAccount,
      importOptions,
    );

    expect(result.draft).toEqual(
      expect.objectContaining({
        serviceKey: 'todo',
        name: 'Todo',
        description: 'Task tracker',
        requesterName: sessionAccount.name,
        requesterEmail: sessionAccount.email,
      }),
    );
    expect(result.warnings).toEqual([
      'Ignored unknown top-level fields: extraField.',
    ]);
  });

  it('removes visitor permission rows and normalizes array fields into textarea strings', () => {
    const result = normalizeImportedServiceRequest(
      {
        serviceKey: 'todo',
        name: 'Todo',
        permissions: [
          { key: 'visitor', label: 'Visitor' },
          { key: 'admin', label: 'Admin', description: 'Elevated access' },
        ],
        oidcClients: [
          {
            clientId: 'todo-web',
            clientType: 'public',
            redirectUris: ['https://todo.example.com/callback'],
            postLogoutRedirectUris: ['https://todo.example.com/logout'],
            allowedScopes: ['openid', 'profile', 'email', 'service.permission'],
          },
        ],
        serviceCredentials: [
          {
            name: 'todo backend',
            description: 'Internal API access',
            scopes: ['account.search', 'permission.read'],
          },
        ],
      },
      sessionAccount,
      importOptions,
    );

    expect(result.draft.permissions).toEqual([
      { key: 'admin', label: 'Admin', description: 'Elevated access' },
    ]);
    expect(result.draft.oidcClients).toEqual([
      {
        clientId: 'todo-web',
        clientType: 'public',
        requirePkce: true,
        redirectUris: 'https://todo.example.com/callback',
        postLogoutRedirectUris: 'https://todo.example.com/logout',
        allowedScopes: 'openid\nprofile\nemail\nservice.permission',
      },
    ]);
    expect(result.draft.serviceCredentials).toEqual([
      {
        name: 'todo backend',
        description: 'Internal API access',
        scopes: 'account.search\npermission.read',
      },
    ]);
    expect(result.warnings).toEqual([
      'Removed visitor permission from the import because auth manages it automatically.',
    ]);
  });

  it('rejects invalid JSON input', () => {
    expect(() =>
      parseImportedServiceRequestText('{', sessionAccount, importOptions),
    ).toThrow('Invalid JSON file. Check the file contents and try again.');
  });

  it('rejects invalid field types without returning a draft', () => {
    expect(() =>
      normalizeImportedServiceRequest(
        {
          serviceKey: 'todo',
          name: 'Todo',
          requesterName: ['invalid'],
          permissions: [{ key: 'member', label: 'Member' }],
        },
        sessionAccount,
        importOptions,
      ),
    ).toThrow('requesterName must be a string.');

    expect(() =>
      normalizeImportedServiceRequest(
        {
          serviceKey: 'todo',
          name: 'Todo',
          permissions: [{ key: 'member', label: 'Member' }],
          oidcClients: 'invalid',
        },
        sessionAccount,
        importOptions,
      ),
    ).toThrow('oidcClients must be an array.');
  });

  it('rejects unsupported credential scopes from the supplied metadata', () => {
    expect(() =>
      normalizeImportedServiceRequest(
        {
          serviceKey: 'todo',
          name: 'Todo',
          permissions: [{ key: 'member', label: 'Member' }],
          serviceCredentials: [
            {
              name: 'todo backend',
              scopes: ['unknown.scope'],
            },
          ],
        },
        sessionAccount,
        importOptions,
      ),
    ).toThrow(
      'serviceCredentials[0].scopes contains unsupported scope unknown.scope.',
    );
  });
});
