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
  permissionWebhook?: {
    url: string;
    signingSecretSource: 'generated' | 'environment';
    eventTypes: Array<'permission.updated' | 'service_application.rejected'>;
  } | null;
};

type ImportResult = {
  draft: ImportedDraft;
  warnings: string[];
};

type ServiceRequestImportModule = {
  normalizeImportedServiceRequest: (
    value: unknown,
    sessionAccount: SessionAccount,
    options?: {
      supportedCredentialScopes: Array<{ key: string }>;
      source?: 'file' | 'paste';
    },
  ) => ImportResult;
  parseImportedServiceRequestText: (
    text: string,
    sessionAccount: SessionAccount,
    options?: {
      supportedCredentialScopes: Array<{ key: string }>;
      source?: 'file' | 'paste';
    },
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

    expect(() =>
      parseImportedServiceRequestText('{', sessionAccount, {
        ...importOptions,
        source: 'paste',
      }),
    ).toThrow('Invalid pasted JSON. Check the pasted contents and try again.');
  });

  it('normalizes pasted JSON with the same result as file import', () => {
    const text = JSON.stringify({
      serviceKey: 'todo',
      name: 'Todo',
      description: 'Task tracker',
      requesterName: 'Ignored Requester',
      requesterEmail: 'ignored@example.com',
      permissions: [
        { key: 'visitor', label: 'Visitor' },
        { key: 'member', label: 'Member', description: 'Standard access' },
      ],
      oidcClients: [
        {
          clientId: 'todo-web',
          clientType: 'public',
          redirectUris: ['https://todo.example.com/callback'],
          allowedScopes: ['openid', 'service.permission'],
          requirePkce: true,
        },
      ],
      serviceCredentials: [
        {
          name: 'todo backend',
          scopes: ['account.search'],
        },
      ],
      permissionWebhook: {
        url: 'https://todo.example.com/auth/events',
        signingSecretSource: 'environment',
        eventTypes: ['permission.updated'],
      },
    });

    const fileResult = parseImportedServiceRequestText(text, sessionAccount, {
      ...importOptions,
      source: 'file',
    });
    const pasteResult = parseImportedServiceRequestText(text, sessionAccount, {
      ...importOptions,
      source: 'paste',
    });

    expect(pasteResult).toEqual(fileResult);
  });

  it('normalizes permission webhook defaults and omits imported secret fields', () => {
    const result = normalizeImportedServiceRequest(
      {
        serviceKey: 'todo',
        name: 'Todo',
        permissions: [],
        permissionWebhook: {
          url: 'https://todo.example.com/auth/events',
          secret: 'must-not-enter-form-state',
          encryptedSecret: 'ciphertext-must-not-enter-form-state',
        },
      },
      sessionAccount,
      importOptions,
    );

    expect(result.draft.permissionWebhook).toEqual({
      url: 'https://todo.example.com/auth/events',
      signingSecretSource: 'generated',
      eventTypes: ['permission.updated', 'service_application.rejected'],
    });
    expect(JSON.stringify(result.draft)).not.toContain(
      'must-not-enter-form-state',
    );
    expect(JSON.stringify(result.draft)).not.toContain(
      'ciphertext-must-not-enter-form-state',
    );
    expect(result.warnings).toEqual([
      'Ignored unknown permissionWebhook fields: secret, encryptedSecret.',
    ]);
  });

  it('preserves webhook omission and explicit null removal', () => {
    const omitted = normalizeImportedServiceRequest(
      {
        serviceKey: 'todo',
        name: 'Todo',
        permissions: [],
      },
      sessionAccount,
      importOptions,
    );

    expect(omitted.draft.permissionWebhook).toBeUndefined();
    expect(JSON.stringify(omitted.draft)).not.toContain('permissionWebhook');

    const removed = normalizeImportedServiceRequest(
      {
        serviceKey: 'todo',
        name: 'Todo',
        permissions: [],
        permissionWebhook: null,
      },
      sessionAccount,
      importOptions,
    );

    expect(removed.draft.permissionWebhook).toBeNull();
    expect(JSON.stringify(removed.draft)).toContain('"permissionWebhook":null');
  });

  it('rejects unsupported webhook values', () => {
    expect(() =>
      normalizeImportedServiceRequest(
        {
          serviceKey: 'todo',
          name: 'Todo',
          permissions: [],
          permissionWebhook: {
            url: 'https://todo.example.com/auth/events',
            signingSecretSource: 'stored',
          },
        },
        sessionAccount,
        importOptions,
      ),
    ).toThrow(
      'permissionWebhook.signingSecretSource must be generated or environment.',
    );

    expect(() =>
      normalizeImportedServiceRequest(
        {
          serviceKey: 'todo',
          name: 'Todo',
          permissions: [],
          permissionWebhook: {
            url: 'https://todo.example.com/auth/events',
            eventTypes: [],
          },
        },
        sessionAccount,
        importOptions,
      ),
    ).toThrow('permissionWebhook.eventTypes must not be empty.');
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
