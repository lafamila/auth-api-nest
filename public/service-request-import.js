(function attachServiceRequestImport(globalObject) {
  const KNOWN_TOP_LEVEL_FIELDS = new Set([
    'serviceKey',
    'name',
    'description',
    'permissions',
    'oidcClients',
    'serviceCredentials',
    'requesterName',
    'requesterEmail',
  ]);
  const SUPPORTED_CLIENT_TYPES = new Set(['public', 'confidential']);

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function ensurePlainObject(value, label) {
    if (!isPlainObject(value)) {
      throw new Error(label + ' must be an object.');
    }
    return value;
  }

  function ensureOptionalString(value, label) {
    if (value === undefined || value === null) {
      return '';
    }
    if (typeof value !== 'string') {
      throw new Error(label + ' must be a string.');
    }
    return value;
  }

  function ensureOptionalStringArray(value, label) {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error(label + ' must be an array.');
    }
    return value.map(function mapItem(item, index) {
      if (typeof item !== 'string') {
        throw new Error(label + ' item ' + (index + 1) + ' must be a string.');
      }
      return item;
    });
  }

  function normalizeJoin(values) {
    return values.join('\n');
  }

  function normalizePermissionRows(value, warnings) {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error('permissions must be an array.');
    }
    const normalized = [];
    value.forEach(function eachPermission(permission, index) {
      const row = ensurePlainObject(permission, 'permissions[' + index + ']');
      const key = ensureOptionalString(
        row.key,
        'permissions[' + index + '].key',
      );
      const label = ensureOptionalString(
        row.label,
        'permissions[' + index + '].label',
      );
      const description = ensureOptionalString(
        row.description,
        'permissions[' + index + '].description',
      );
      if (key.trim() === 'visitor') {
        warnings.push(
          'Removed visitor permission from the import because auth manages it automatically.',
        );
        return;
      }
      normalized.push({
        key: key,
        label: label,
        description: description,
      });
    });
    return normalized;
  }

  function normalizeOidcClientRows(value) {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error('oidcClients must be an array.');
    }
    return value.map(function mapClient(client, index) {
      const row = ensurePlainObject(client, 'oidcClients[' + index + ']');
      const clientId = ensureOptionalString(
        row.clientId,
        'oidcClients[' + index + '].clientId',
      );
      const clientType = ensureOptionalString(
        row.clientType,
        'oidcClients[' + index + '].clientType',
      );
      if (!SUPPORTED_CLIENT_TYPES.has(clientType)) {
        throw new Error(
          'oidcClients[' +
            index +
            '].clientType must be public or confidential.',
        );
      }
      const redirectUris = ensureOptionalStringArray(
        row.redirectUris,
        'oidcClients[' + index + '].redirectUris',
      );
      const postLogoutRedirectUris = ensureOptionalStringArray(
        row.postLogoutRedirectUris,
        'oidcClients[' + index + '].postLogoutRedirectUris',
      );
      const allowedScopes = ensureOptionalStringArray(
        row.allowedScopes,
        'oidcClients[' + index + '].allowedScopes',
      );
      let requirePkce = true;
      if (row.requirePkce !== undefined && row.requirePkce !== null) {
        if (typeof row.requirePkce !== 'boolean') {
          throw new Error(
            'oidcClients[' + index + '].requirePkce must be a boolean.',
          );
        }
        requirePkce = row.requirePkce;
      }
      return {
        clientId: clientId,
        clientType: clientType,
        requirePkce: requirePkce,
        redirectUris: normalizeJoin(redirectUris),
        postLogoutRedirectUris: normalizeJoin(postLogoutRedirectUris),
        allowedScopes: normalizeJoin(allowedScopes),
      };
    });
  }

  function supportedScopeSet(options) {
    return new Set(
      (options && Array.isArray(options.supportedCredentialScopes)
        ? options.supportedCredentialScopes
        : []
      )
        .map(function mapScope(scope) {
          if (typeof scope === 'string') return scope;
          return scope && typeof scope.key === 'string' ? scope.key : '';
        })
        .filter(Boolean),
    );
  }

  function normalizeServiceCredentialRows(value, options) {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error('serviceCredentials must be an array.');
    }
    const supportedScopes = supportedScopeSet(options);
    return value.map(function mapCredential(credential, index) {
      const row = ensurePlainObject(
        credential,
        'serviceCredentials[' + index + ']',
      );
      const name = ensureOptionalString(
        row.name,
        'serviceCredentials[' + index + '].name',
      );
      const description = ensureOptionalString(
        row.description,
        'serviceCredentials[' + index + '].description',
      );
      const scopes = ensureOptionalStringArray(
        row.scopes,
        'serviceCredentials[' + index + '].scopes',
      );
      scopes.forEach(function validateScope(scope) {
        if (supportedScopes.size && !supportedScopes.has(scope)) {
          throw new Error(
            'serviceCredentials[' +
              index +
              '].scopes contains unsupported scope ' +
              scope +
              '.',
          );
        }
      });
      return {
        name: name,
        description: description,
        scopes: normalizeJoin(scopes),
      };
    });
  }

  function normalizeImportedServiceRequest(value, sessionAccount, options) {
    const root = ensurePlainObject(value, 'Imported JSON root');
    const warnings = [];
    const unknownFields = Object.keys(root).filter(function isUnknown(field) {
      return !KNOWN_TOP_LEVEL_FIELDS.has(field);
    });
    if (unknownFields.length) {
      warnings.push(
        'Ignored unknown top-level fields: ' + unknownFields.join(', ') + '.',
      );
    }
    const sessionName =
      sessionAccount && typeof sessionAccount.name === 'string'
        ? sessionAccount.name
        : '';
    const sessionEmail =
      sessionAccount && typeof sessionAccount.email === 'string'
        ? sessionAccount.email
        : '';
    ensureOptionalString(root.requesterName, 'requesterName');
    ensureOptionalString(root.requesterEmail, 'requesterEmail');
    return {
      draft: {
        serviceKey: ensureOptionalString(root.serviceKey, 'serviceKey'),
        name: ensureOptionalString(root.name, 'name'),
        description: ensureOptionalString(root.description, 'description'),
        requesterName: sessionName,
        requesterEmail: sessionEmail,
        permissions: normalizePermissionRows(root.permissions, warnings),
        oidcClients: normalizeOidcClientRows(root.oidcClients),
        serviceCredentials: normalizeServiceCredentialRows(
          root.serviceCredentials,
          options,
        ),
      },
      warnings: warnings,
    };
  }

  function parseImportedServiceRequestText(text, sessionAccount, options) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        'Invalid JSON file. Check the file contents and try again.',
      );
    }
    return normalizeImportedServiceRequest(parsed, sessionAccount, options);
  }

  const api = {
    normalizeImportedServiceRequest: normalizeImportedServiceRequest,
    parseImportedServiceRequestText: parseImportedServiceRequestText,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  globalObject.ServiceRequestImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
