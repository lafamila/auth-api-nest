import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import {
  renderSocialErrorPage,
  renderSocialSignupPage,
  type SocialSignupPageInput,
} from './social-pages';

class FakeClassList {
  private readonly values = new Set<string>();

  add(...tokens: string[]) {
    tokens.forEach((token) => this.values.add(token));
  }

  remove(...tokens: string[]) {
    tokens.forEach((token) => this.values.delete(token));
  }

  contains(token: string) {
    return this.values.has(token);
  }

  toggle(token: string, force?: boolean) {
    const shouldAdd = force ?? !this.values.has(token);
    if (shouldAdd) {
      this.values.add(token);
    } else {
      this.values.delete(token);
    }
    return shouldAdd;
  }
}

class FakeEvent {
  defaultPrevented = false;

  constructor(readonly type: string) {}

  preventDefault() {
    this.defaultPrevented = true;
  }
}

type FakeEventListener = (event: FakeEvent) => unknown;

class FakeElement {
  checked = false;
  value = '';
  textContent = '';
  disabled = false;
  readOnly = false;
  required = false;
  hidden = false;
  dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, FakeEventListener[]>();

  constructor(readonly id: string) {}

  addEventListener(type: string, listener: FakeEventListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === 'aria-busy') {
      return;
    }
    if (name === 'disabled') {
      this.disabled = true;
    }
    if (name === 'required') {
      this.required = true;
    }
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === 'disabled') {
      this.disabled = false;
    }
    if (name === 'required') {
      this.required = false;
    }
  }

  checkValidity = jest.fn(() => true);

  async dispatch(type: string) {
    const event = new FakeEvent(type);
    for (const listener of this.listeners.get(type) ?? []) {
      await listener(event);
    }
    return event;
  }
}

class FakeDocument {
  readyState = 'complete';

  constructor(private readonly elements: Map<string, FakeElement>) {}

  getElementById(id: string) {
    return this.elements.get(id) ?? null;
  }

  querySelector(selector: string) {
    return selector.startsWith('#')
      ? (this.elements.get(selector.slice(1)) ?? null)
      : null;
  }

  addEventListener(type: string, listener: FakeEventListener) {
    if (type === 'DOMContentLoaded') {
      listener(new FakeEvent(type));
    }
  }
}

interface FetchCall {
  url: string;
  options?: {
    method?: string;
    mode?: string;
    credentials?: string;
    redirect?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
}

interface FakeResponse {
  ok: boolean;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface ScriptHarness {
  element(id: string): FakeElement;
  fetchCalls: FetchCall[];
  queueResponse(response: Promise<FakeResponse> | FakeResponse): void;
}

const elementIds = [
  'socialSignupForm',
  'transaction',
  'name',
  'email',
  'sendEmailButton',
  'codeField',
  'code',
  'verifyCodeButton',
  'continueButton',
  'nameCheck',
  'emailCheck',
  'codeCheck',
  'nameFeedback',
  'emailFeedback',
  'codeFeedback',
  'message',
  'termsAccepted',
  'privacyAccepted',
  'termsVersion',
  'privacyVersion',
  'policyDigest',
  'policyFeedback',
  'loadPoliciesButton',
] as const;

function response(body: unknown = {}, ok = true): FakeResponse {
  const raw = JSON.stringify(body);
  return {
    ok,
    statusText: ok ? 'OK' : 'Bad Request',
    text: async () => raw,
    json: async () => body,
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

function loadSignupScript(
  emailVerified = false,
  options: { agreed?: boolean; policy?: Record<string, string> } = {},
): ScriptHarness {
  const elements = new Map<string, FakeElement>();
  const verifiedProviderOmissions = new Set([
    'sendEmailButton',
    'codeField',
    'code',
    'codeCheck',
    'verifyCodeButton',
  ]);
  elementIds.forEach((id) => {
    if (!emailVerified || !verifiedProviderOmissions.has(id)) {
      elements.set(id, new FakeElement(id));
    }
  });

  const element = (id: string) => {
    const result = elements.get(id);
    if (!result) {
      throw new Error(`Unknown fake element: ${id}`);
    }
    return result;
  };

  element('socialSignupForm').dataset.emailVerified = String(emailVerified);
  element('transaction').value = 'transaction-1';
  if (!emailVerified) {
    element('codeField').hidden = true;
  }
  element('continueButton').disabled = true;
  element('email').readOnly = emailVerified;
  element('email').value = 'social@example.com';
  element('name').value = 'Social User';
  element('termsVersion').value = element('privacyVersion').value =
    '2026-11-18';
  element('policyDigest').value = 'a'.repeat(64);
  element('termsAccepted').checked = element('privacyAccepted').checked =
    options.agreed ?? true;
  for (const [key, value] of Object.entries(options.policy ?? {})) {
    element(key).value = value;
  }
  for (const id of ['nameCheck', 'emailCheck', 'codeCheck']) {
    if (elements.has(id)) {
      element(id).hidden = true;
    }
  }

  const responses: Array<Promise<FakeResponse>> = [];
  const fetchCalls: FetchCall[] = [];
  const fetch = jest.fn((url: string, options?: FetchCall['options']) => {
    fetchCalls.push({ url, options });
    return responses.shift() ?? Promise.resolve(response());
  });
  const document = new FakeDocument(elements);
  const context = createContext({
    console,
    document,
    fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    AbortController,
    Date,
    window: {
      document,
      location: { origin: 'https://auth.example.com' },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
  });
  const source = readFileSync(
    resolve(__dirname, '../../public/social-signup.js'),
    'utf8',
  );
  runInContext(source, context, { filename: 'social-signup.js' });

  return {
    element,
    fetchCalls,
    queueResponse: (queuedResponse) => {
      responses.push(Promise.resolve(queuedResponse));
    },
  };
}

function signupInput(
  overrides: Partial<SocialSignupPageInput> = {},
): SocialSignupPageInput {
  return {
    transaction: 'social-transaction',
    email: 'social@example.com',
    emailVerified: false,
    name: 'Social User',
    policy: {
      termsVersion: '2026-11-18',
      privacyVersion: '2026-11-18',
      policyDigest: 'a'.repeat(64),
    },
    ...overrides,
  };
}

describe('renderSocialSignupPage', () => {
  it('renders required, unchecked agreement controls and the exact server policy metadata', () => {
    const html = renderSocialSignupPage(signupInput());
    for (const id of ['termsAccepted', 'privacyAccepted']) {
      const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))![0];
      expect(input).toContain('type="checkbox"');
      expect(input).toContain('value="true"');
      expect(input).toMatch(/\srequired(?:\s|\/?>)/);
      expect(input).not.toMatch(/\schecked(?:[\s=>]|\/?>)/);
    }
    for (const [key, value] of Object.entries(signupInput().policy!)) {
      expect(html).toMatch(
        new RegExp(
          `id="${key}"[^>]*name="${key}"[^>]*type="hidden"[^>]*value="${value}"`,
        ),
      );
    }
    expect(html).not.toMatch(/name="(?:termsUrl|privacyUrl)"/);
  });

  it('escapes policy metadata attributes instead of allowing hidden-field injection', () => {
    const value = '"><img src=x onerror=policy()>';
    const html = renderSocialSignupPage(
      signupInput({
        policy: {
          termsVersion: value,
          privacyVersion: value,
          policyDigest: value,
        },
      }),
    );
    expect(html).not.toContain('<img src=x onerror=policy()>');
    expect(
      html.match(/value="&quot;&gt;&lt;img src=x onerror=policy\(\)&gt;"/g),
    ).toHaveLength(3);
  });
  it('escapes every caller-controlled value including the transaction attribute', () => {
    const html = renderSocialSignupPage(
      signupInput({
        transaction: 'tx"><script>transaction()</script>',
        email: 'email"><img src=x onerror=email()>',
        name: '<script>name()</script>',
        error: '<img src=x onerror=error()>',
      }),
    );

    expect(html).not.toContain('<script>transaction()</script>');
    expect(html).not.toContain('<img src=x onerror=email()>');
    expect(html).not.toContain('<script>name()</script>');
    expect(html).not.toContain('<img src=x onerror=error()>');
    expect(html).toContain(
      'value="tx&quot;&gt;&lt;script&gt;transaction()&lt;/script&gt;"',
    );
    expect(html).toContain('email&quot;&gt;&lt;img src=x onerror=email()&gt;');
    expect(html).toContain('&lt;script&gt;name()&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=error()&gt;');
  });

  it('renders a verified email as readonly without email verification controls', () => {
    const html = renderSocialSignupPage(signupInput({ emailVerified: true }));

    expect(html).toContain('data-email-verified="true"');
    expect(html).toMatch(/id="email"[^>]*readonly/);
    expect(html).not.toContain('id="sendEmailButton"');
    expect(html).not.toContain('id="verifyCodeButton"');
  });

  it('renders an unverified email with send and code verification controls', () => {
    const html = renderSocialSignupPage(signupInput());

    expect(html).toContain('data-email-verified="false"');
    expect(html).not.toMatch(/id="email"[^>]*readonly/);
    expect(html).toContain('id="sendEmailButton"');
    expect(html).toMatch(/id="codeField"[^>]*hidden/);
    expect(html).toContain('id="code"');
    expect(html).toContain('id="verifyCodeButton"');
  });

  it('renders the native completion form and the complete field contract', () => {
    const html = renderSocialSignupPage(signupInput());

    expect(html).toMatch(
      /<form[^>]*id="socialSignupForm"[^>]*method="post"[^>]*action="\/oauth\/social\/complete"/,
    );
    expect(html).toMatch(
      /id="transaction"[^>]*type="hidden"[^>]*name="transaction"[^>]*value="social-transaction"/,
    );
    for (const name of ['transaction', 'name', 'email']) {
      expect(html).toMatch(new RegExp(`name="${name}"`));
    }
    for (const id of elementIds) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it.each([false, true])(
    'omits every credential control with emailVerified=%s',
    (emailVerified) => {
      const html = renderSocialSignupPage(signupInput({ emailVerified }));

      for (const field of ['loginId', 'password', 'passwordConfirm']) {
        expect(html).not.toContain(`name="${field}"`);
        expect(html).not.toContain(`id="${field}"`);
      }
      expect(html).not.toContain('id="passwordFields"');
      expect(html).not.toContain('id="checkLoginIdButton"');
      expect(html).not.toContain('autocomplete="username"');
      expect(html).not.toContain('autocomplete="new-password"');
      expect(html).toMatch(/id="continueButton"[^>]*disabled/);
    },
  );

  it('loads one deferred external script without inline JavaScript or event attributes', () => {
    const html = renderSocialSignupPage(signupInput());
    const scripts = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/g) ?? [];

    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(
      /src="\/oauth\/social\/signup\.js"[^>]*defer|defer[^>]*src="\/oauth\/social\/signup\.js"/,
    );
    expect(scripts[0]).toMatch(/>\s*<\/script>$/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

describe('renderSocialErrorPage', () => {
  it('escapes the error message and does not expose an admin link', () => {
    const html = renderSocialErrorPage(
      '</h1><script>error()</script><a href="/admin">admin</a>',
    );

    expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
    expect(html).toContain(
      '&lt;/h1&gt;&lt;script&gt;error()&lt;/script&gt;&lt;a href=&quot;/admin&quot;&gt;admin&lt;/a&gt;',
    );
    expect(html).not.toContain('<script>error()</script>');
    expect(html).not.toContain('href="/admin"');
  });
});

describe('social signup browser behavior', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not fetch or overwrite valid initial hidden policy metadata', () => {
    const page = loadSignupScript(true, { agreed: false });
    expect(page.fetchCalls).toEqual([]);
    expect(page.element('termsVersion').value).toBe('2026-11-18');
    expect(page.element('privacyVersion').value).toBe('2026-11-18');
    expect(page.element('policyDigest').value).toBe('a'.repeat(64));
    expect(page.element('continueButton').disabled).toBe(true);
  });

  it('requires both explicitly checked boxes and blocks submit again when either is unchecked', async () => {
    const page = loadSignupScript(true, { agreed: false });
    expect(
      (await page.element('socialSignupForm').dispatch('submit'))
        .defaultPrevented,
    ).toBe(true);
    page.element('termsAccepted').checked = true;
    await page.element('termsAccepted').dispatch('change');
    expect(page.element('continueButton').disabled).toBe(true);
    page.element('privacyAccepted').checked = true;
    await page.element('privacyAccepted').dispatch('change');
    expect(page.element('continueButton').disabled).toBe(false);
    for (const id of ['termsAccepted', 'privacyAccepted']) {
      page.element(id).checked = false;
      await page.element(id).dispatch('change');
      expect(page.element('continueButton').disabled).toBe(true);
      expect(
        (await page.element('socialSignupForm').dispatch('submit'))
          .defaultPrevented,
      ).toBe(true);
      page.element(id).checked = true;
      await page.element(id).dispatch('change');
    }
    expect(
      (await page.element('socialSignupForm').dispatch('submit'))
        .defaultPrevented,
    ).toBe(false);
    expect(page.fetchCalls).toEqual([]);
  });

  it('keeps stale-looking hidden metadata intact for server validation instead of silently changing the agreed version', () => {
    const policy = {
      termsVersion: 'old-version',
      privacyVersion: 'old-version',
      policyDigest: 'b'.repeat(64),
    };
    const page = loadSignupScript(true, { agreed: false, policy });
    expect(page.fetchCalls).toEqual([]);
    for (const [key, value] of Object.entries(policy))
      expect(page.element(key).value).toBe(value);
    expect(page.element('continueButton').disabled).toBe(true);
  });

  it.each(['termsVersion', 'privacyVersion', 'policyDigest'])(
    'blocks completion and clears agreement when initial %s is invalid',
    async (field) => {
      const page = loadSignupScript(true, { policy: { [field]: '' } });
      expect(page.element('continueButton').disabled).toBe(true);
      expect(page.element('termsAccepted').checked).toBe(false);
      expect(page.element('privacyAccepted').checked).toBe(false);
      expect(page.fetchCalls).toHaveLength(1);
      expect(page.fetchCalls[0].url).toBe('/api/public/policies');
      expect(
        (await page.element('socialSignupForm').dispatch('submit'))
          .defaultPrevented,
      ).toBe(true);
    },
  );

  it('clears old checkbox agreement when policy metadata is explicitly refreshed', async () => {
    const page = loadSignupScript(true);
    page.queueResponse(
      response({
        termsVersion: 'next-version',
        privacyVersion: 'next-version',
        policyDigest: 'b'.repeat(64),
        termsUrl: '/terms',
        privacyUrl: '/privacy',
      }),
    );
    await page.element('loadPoliciesButton').dispatch('click');
    await jest.advanceTimersByTimeAsync(0);
    expect(page.element('termsAccepted').checked).toBe(false);
    expect(page.element('privacyAccepted').checked).toBe(false);
    expect(page.element('termsVersion').value).toBe('next-version');
    expect(page.element('policyDigest').value).toBe('b'.repeat(64));
    expect(page.element('continueButton').disabled).toBe(true);
  });

  it.each([
    { email: 'x@localhost', valid: true },
    { email: 'user@example.com', valid: true },
    { email: 'bad@@example.com', valid: false },
    { email: 'space value@example.com', valid: false },
    { email: '', valid: false },
  ])('uses native email validity for "$email"', async ({ email, valid }) => {
    const page = loadSignupScript();
    page.element('email').value = email;
    page.element('email').checkValidity.mockReturnValue(valid);

    await page.element('email').dispatch('input');

    expect(page.element('sendEmailButton').disabled).toBe(!valid);
    expect(page.element('continueButton').disabled).toBe(true);
    if (!valid) {
      await page.element('sendEmailButton').dispatch('click');
      expect(page.fetchCalls).toHaveLength(0);
    }
  });

  it('starts email verification with the social transaction and email', async () => {
    const page = loadSignupScript();
    page.element('email').value = 'updated@example.com';
    await page.element('email').dispatch('input');
    page.queueResponse(response());

    await page.element('sendEmailButton').dispatch('click');

    expect(page.fetchCalls[0]).toMatchObject({
      url: '/oauth/social/email/start',
      options: {
        method: 'POST',
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          transaction: 'transaction-1',
          email: 'updated@example.com',
        }),
      },
    });
    expect(page.element('codeField').hidden).toBe(false);
  });

  it('shows request loading state until an email-send response settles', async () => {
    const page = loadSignupScript();
    const pending = deferred<FakeResponse>();
    page.queueResponse(pending.promise);

    const request = page.element('sendEmailButton').dispatch('click');

    expect(page.element('sendEmailButton').disabled).toBe(true);
    expect(page.element('sendEmailButton').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(page.element('emailFeedback').textContent.length).toBeGreaterThan(0);

    pending.resolve(response());
    await request;
    expect(page.element('sendEmailButton').getAttribute('aria-busy')).toBe(
      'false',
    );
  });

  it('keeps the send button cooling down for 60 seconds after success', async () => {
    const page = loadSignupScript();
    page.queueResponse(response());

    await page.element('sendEmailButton').dispatch('click');

    expect(page.element('sendEmailButton').disabled).toBe(true);
    jest.advanceTimersByTime(59_999);
    expect(page.element('sendEmailButton').disabled).toBe(true);
    jest.advanceTimersByTime(1);
    expect(page.element('sendEmailButton').disabled).toBe(false);
  });

  it('ignores an email-send response after the email changes', async () => {
    const page = loadSignupScript();
    const pending = deferred<FakeResponse>();
    page.queueResponse(pending.promise);
    const request = page.element('sendEmailButton').dispatch('click');

    page.element('email').value = 'different@example.com';
    await page.element('email').dispatch('input');
    pending.resolve(response());
    await request;

    expect(page.element('codeField').hidden).toBe(true);
    expect(page.element('emailCheck').hidden).toBe(true);
  });

  it.each([
    { case: 'empty', code: '' },
    { case: 'too short', code: 'ABC12' },
    { case: 'special-character', code: 'ABC12!' },
    { case: 'whitespace', code: 'ABC 12' },
    { case: 'too long', code: 'ABC1234' },
  ])(
    'rejects a $case verification code without a request',
    async ({ code }) => {
      const page = loadSignupScript();
      page.queueResponse(response());
      await page.element('sendEmailButton').dispatch('click');
      page.element('code').value = code;
      await page.element('code').dispatch('input');

      await page.element('verifyCodeButton').dispatch('click');

      expect(page.fetchCalls).toHaveLength(1);
      expect(page.element('verifyCodeButton').disabled).toBe(true);
    },
  );

  it('verifies a six-character alphanumeric code for the transaction', async () => {
    const page = loadSignupScript();
    page.queueResponse(response());
    await page.element('sendEmailButton').dispatch('click');
    page.element('code').value = 'A1B2C3';
    await page.element('code').dispatch('input');
    page.queueResponse(response());

    await page.element('verifyCodeButton').dispatch('click');

    expect(page.fetchCalls[1]).toMatchObject({
      url: '/oauth/social/email/verify',
      options: {
        method: 'POST',
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ transaction: 'transaction-1', code: 'A1B2C3' }),
      },
    });
    expect(page.element('codeCheck').hidden).toBe(false);
    expect(page.element('email').readOnly).toBe(true);
    expect(page.element('code').readOnly).toBe(true);
    expect(page.element('sendEmailButton').hidden).toBe(true);
    expect(page.element('codeField').hidden).toBe(true);
  });

  it('ignores a verification response after the email changes', async () => {
    const page = loadSignupScript();
    page.queueResponse(response());
    await page.element('sendEmailButton').dispatch('click');
    page.element('code').value = 'A1B2C3';
    await page.element('code').dispatch('input');
    const pending = deferred<FakeResponse>();
    page.queueResponse(pending.promise);
    const request = page.element('verifyCodeButton').dispatch('click');

    page.element('email').value = 'different@example.com';
    await page.element('email').dispatch('input');
    pending.resolve(response());
    await request;

    expect(page.element('email').readOnly).toBe(false);
    expect(page.element('code').readOnly).toBe(false);
    expect(page.element('emailCheck').hidden).toBe(true);
    expect(page.element('codeCheck').hidden).toBe(true);
  });

  it('shows request loading state until a code-verification response settles', async () => {
    const page = loadSignupScript();
    page.queueResponse(response());
    await page.element('sendEmailButton').dispatch('click');
    page.element('code').value = 'A1B2C3';
    await page.element('code').dispatch('input');
    const pending = deferred<FakeResponse>();
    page.queueResponse(pending.promise);

    const request = page.element('verifyCodeButton').dispatch('click');

    expect(page.element('verifyCodeButton').disabled).toBe(true);
    expect(page.element('email').readOnly).toBe(true);
    expect(page.element('code').readOnly).toBe(true);
    expect(page.element('sendEmailButton').hidden).toBe(false);
    expect(page.element('codeField').hidden).toBe(false);
    expect(page.element('verifyCodeButton').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(page.element('codeFeedback').textContent.length).toBeGreaterThan(0);

    pending.resolve(response());
    await request;
    expect(page.element('verifyCodeButton').getAttribute('aria-busy')).toBe(
      'false',
    );
  });

  it.each([
    {
      action: 'email send',
      buttonId: 'sendEmailButton',
      feedbackId: 'emailFeedback',
      editableAfter: [] as string[],
      visibleAfter: [] as string[],
      prepare: async (page: ScriptHarness) => {
        await page.element('email').dispatch('input');
      },
    },
    {
      action: 'code verification',
      buttonId: 'verifyCodeButton',
      feedbackId: 'codeFeedback',
      editableAfter: ['email', 'code'],
      visibleAfter: ['sendEmailButton', 'codeField'],
      prepare: async (page: ScriptHarness) => {
        page.queueResponse(response());
        await page.element('sendEmailButton').dispatch('click');
        page.element('code').value = 'A1B2C3';
        await page.element('code').dispatch('input');
      },
    },
  ])(
    'restores the $action controls after an endpoint error',
    async ({ buttonId, feedbackId, editableAfter, visibleAfter, prepare }) => {
      const page = loadSignupScript();
      await prepare(page);
      page.queueResponse(response({ message: 'Rejected request' }, false));

      await page.element(buttonId).dispatch('click');

      expect(page.element(buttonId).disabled).toBe(false);
      expect(page.element(buttonId).getAttribute('aria-busy')).toBe('false');
      expect(page.element(feedbackId).textContent).toContain(
        'Rejected request',
      );
      for (const id of editableAfter) {
        expect(page.element(id).readOnly).toBe(false);
      }
      for (const id of visibleAfter) {
        expect(page.element(id).hidden).toBe(false);
      }
    },
  );

  it('normalizes social fields and leaves completion to the native form POST', async () => {
    const page = loadSignupScript(true);
    page.element('name').value = '  Social User  ';
    page.element('email').value = '  social@example.com  ';

    const submit = await page.element('socialSignupForm').dispatch('submit');

    expect(submit.defaultPrevented).toBe(false);
    expect(page.element('name').value).toBe('Social User');
    expect(page.element('email').value).toBe('social@example.com');
    expect(page.fetchCalls).toHaveLength(0);
  });

  it('submits once without credential controls and keeps social fields successful', async () => {
    const page = loadSignupScript(true);

    const submit = await page.element('socialSignupForm').dispatch('submit');

    expect(submit.defaultPrevented).toBe(false);
    for (const id of ['transaction', 'name', 'email']) {
      expect(page.element(id).disabled).toBe(false);
    }
    expect(page.element('name').readOnly).toBe(true);
    expect(page.element('email').readOnly).toBe(true);
    expect(page.element('continueButton').disabled).toBe(true);
    expect(page.element('socialSignupForm').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(
      (await page.element('socialSignupForm').dispatch('submit'))
        .defaultPrevented,
    ).toBe(true);
    expect(page.fetchCalls).toHaveLength(0);
  });

  it('blocks unverified signup and permits submission only after email OTP succeeds', async () => {
    const page = loadSignupScript();
    expect(
      (await page.element('socialSignupForm').dispatch('submit'))
        .defaultPrevented,
    ).toBe(true);
    await page.element('sendEmailButton').dispatch('click');
    expect(page.element('continueButton').disabled).toBe(true);
    page.element('code').value = 'A1B2C3';
    await page.element('code').dispatch('input');
    await page.element('verifyCodeButton').dispatch('click');

    expect(page.element('continueButton').disabled).toBe(false);
    expect(
      (await page.element('socialSignupForm').dispatch('submit'))
        .defaultPrevented,
    ).toBe(false);
    expect(page.fetchCalls.map((call) => call.url)).toEqual([
      '/oauth/social/email/start',
      '/oauth/social/email/verify',
    ]);
  });

  it.each([
    { field: 'name', value: '', valid: true },
    { field: 'name', value: '   ', valid: true },
    { field: 'name', value: 'Social User', valid: false },
    { field: 'email', value: 'invalid', valid: false },
  ])(
    'blocks invalid $field without requesting credentials',
    async ({ field, value, valid }) => {
      const page = loadSignupScript(true);
      page.element(field).value = value;
      page.element(field).checkValidity.mockReturnValue(valid);
      await page.element(field).dispatch('input');

      expect(page.element('continueButton').disabled).toBe(true);
      expect(
        (await page.element('socialSignupForm').dispatch('submit'))
          .defaultPrevented,
      ).toBe(true);
      expect(page.fetchCalls).toHaveLength(0);
    },
  );
});
