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
  'loginId',
  'checkLoginIdButton',
  'passwordFields',
  'password',
  'passwordConfirm',
  'continueButton',
  'nameCheck',
  'emailCheck',
  'codeCheck',
  'loginIdCheck',
  'passwordCheck',
  'passwordConfirmCheck',
  'nameFeedback',
  'emailFeedback',
  'codeFeedback',
  'loginIdFeedback',
  'passwordFeedback',
  'passwordConfirmFeedback',
  'message',
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

function loadSignupScript(emailVerified = false): ScriptHarness {
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
  element('passwordFields').hidden = true;
  element('password').disabled = true;
  element('passwordConfirm').disabled = true;
  element('continueButton').disabled = true;
  element('email').readOnly = emailVerified;
  element('email').value = 'social@example.com';
  element('name').value = 'Social User';
  for (const id of [
    'nameCheck',
    'emailCheck',
    'codeCheck',
    'loginIdCheck',
    'passwordCheck',
    'passwordConfirmCheck',
  ]) {
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
    ...overrides,
  };
}

describe('renderSocialSignupPage', () => {
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
    for (const name of [
      'transaction',
      'name',
      'email',
      'loginId',
      'password',
      'passwordConfirm',
    ]) {
      expect(html).toMatch(new RegExp(`name="${name}"`));
    }
    for (const id of elementIds) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('keeps optional credentials inactive until a login ID is supplied', () => {
    const html = renderSocialSignupPage(signupInput());

    const loginId = html.match(/<input[^>]*id="loginId"[^>]*>/)?.[0] ?? '';
    const password = html.match(/<input[^>]*id="password"[^>]*>/)?.[0] ?? '';
    const passwordConfirm =
      html.match(/<input[^>]*id="passwordConfirm"[^>]*>/)?.[0] ?? '';
    expect(loginId).not.toContain('required');
    expect(password).toContain('disabled');
    expect(password).not.toContain('required');
    expect(passwordConfirm).toContain('disabled');
    expect(passwordConfirm).not.toContain('required');
    expect(html).toMatch(/id="passwordFields"[^>]*hidden/);
    expect(html).toMatch(/id="continueButton"[^>]*disabled/);
  });

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

  it('posts a trimmed login ID to the availability endpoint on the same origin', async () => {
    const page = loadSignupScript();
    page.element('loginId').value = '  social-user  ';
    page.queueResponse(response({ available: true }));

    await page.element('checkLoginIdButton').dispatch('click');

    expect(page.fetchCalls).toHaveLength(1);
    expect(page.fetchCalls[0]).toMatchObject({
      url: '/api/signup/check-login-id',
      options: {
        method: 'POST',
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ loginId: 'social-user' }),
      },
    });
    expect(page.element('loginIdCheck').hidden).toBe(false);
  });

  it('ignores an availability response after the login ID changes', async () => {
    const page = loadSignupScript();
    const pending = deferred<FakeResponse>();
    page.element('loginId').value = 'first-id';
    page.queueResponse(pending.promise);
    const request = page.element('checkLoginIdButton').dispatch('click');

    page.element('loginId').value = 'second-id';
    await page.element('loginId').dispatch('input');
    pending.resolve(response({ available: true }));
    await request;

    expect(page.element('loginIdCheck').hidden).toBe(true);
    expect(page.element('checkLoginIdButton').disabled).toBe(false);
  });

  it('shows request loading state until an availability response settles', async () => {
    const page = loadSignupScript();
    const pending = deferred<FakeResponse>();
    page.element('loginId').value = 'social-user';
    page.queueResponse(pending.promise);

    const request = page.element('checkLoginIdButton').dispatch('click');

    expect(page.element('checkLoginIdButton').disabled).toBe(true);
    expect(page.element('checkLoginIdButton').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(page.element('loginIdFeedback').textContent.length).toBeGreaterThan(
      0,
    );

    pending.resolve(response({ available: false }));
    await request;
    expect(page.element('checkLoginIdButton').getAttribute('aria-busy')).toBe(
      'false',
    );
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
      action: 'login ID check',
      buttonId: 'checkLoginIdButton',
      feedbackId: 'loginIdFeedback',
      editableAfter: [] as string[],
      visibleAfter: [] as string[],
      prepare: async (page: ScriptHarness) => {
        page.element('loginId').value = 'social-user';
        await page.element('loginId').dispatch('input');
      },
    },
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

  it('enables credential fields when a login ID is entered', async () => {
    const page = loadSignupScript();
    page.element('loginId').value = 'social-user';

    await page.element('loginId').dispatch('input');

    expect(page.element('passwordFields').hidden).toBe(false);
    expect(page.element('password').disabled).toBe(false);
    expect(page.element('password').required).toBe(true);
    expect(page.element('passwordConfirm').disabled).toBe(false);
    expect(page.element('passwordConfirm').required).toBe(true);
  });

  it('clears and disables credential fields when the login ID is removed', async () => {
    const page = loadSignupScript();
    page.element('loginId').value = 'social-user';
    await page.element('loginId').dispatch('input');
    page.element('password').value = 'password!';
    page.element('passwordConfirm').value = 'password!';

    page.element('loginId').value = '   ';
    await page.element('loginId').dispatch('input');

    expect(page.element('password').value).toBe('');
    expect(page.element('passwordConfirm').value).toBe('');
    expect(page.element('password').disabled).toBe(true);
    expect(page.element('password').required).toBe(false);
    expect(page.element('passwordConfirm').disabled).toBe(true);
    expect(page.element('passwordConfirm').required).toBe(false);
    expect(page.element('passwordFields').hidden).toBe(true);
  });

  it('validates a password only after the one-second debounce', async () => {
    const page = loadSignupScript();
    page.element('loginId').value = 'social-user';
    await page.element('loginId').dispatch('input');
    page.element('password').value = 'password!';

    await page.element('password').dispatch('input');
    expect(page.element('passwordCheck').hidden).toBe(true);
    jest.advanceTimersByTime(999);
    expect(page.element('passwordCheck').hidden).toBe(true);
    jest.advanceTimersByTime(1);
    expect(page.element('passwordCheck').hidden).toBe(false);
  });

  it.each(['short!', 'password1'])(
    'rejects password %s after the debounce',
    async (password) => {
      const page = loadSignupScript();
      page.element('loginId').value = 'social-user';
      await page.element('loginId').dispatch('input');
      page.element('password').value = password;

      await page.element('password').dispatch('input');
      jest.advanceTimersByTime(1_000);

      expect(page.element('passwordCheck').hidden).toBe(true);
      expect(
        page.element('passwordFeedback').textContent.length,
      ).toBeGreaterThan(0);
    },
  );

  it('runs password and confirmation validation on independent debounces', async () => {
    const page = loadSignupScript();
    page.element('loginId').value = 'social-user';
    await page.element('loginId').dispatch('input');
    page.element('password').value = 'password!';
    await page.element('password').dispatch('input');
    jest.advanceTimersByTime(500);
    page.element('passwordConfirm').value = 'password!';
    await page.element('passwordConfirm').dispatch('input');

    jest.advanceTimersByTime(500);
    expect(page.element('passwordCheck').hidden).toBe(false);
    expect(page.element('passwordConfirmCheck').hidden).toBe(true);
    jest.advanceTimersByTime(499);
    expect(page.element('passwordConfirmCheck').hidden).toBe(true);
    jest.advanceTimersByTime(1);

    expect(page.element('passwordConfirmCheck').hidden).toBe(false);
    expect(page.element('passwordConfirmFeedback').textContent).toBe('');
  });

  it('normalizes the login ID and leaves completion to the native form POST', async () => {
    const page = loadSignupScript(true);
    page.element('loginId').value = '  social-user  ';
    await page.element('loginId').dispatch('input');
    page.queueResponse(response({ available: true }));
    await page.element('checkLoginIdButton').dispatch('click');
    page.element('password').value = 'password!';
    page.element('passwordConfirm').value = 'password!';
    await page.element('password').dispatch('input');
    await page.element('passwordConfirm').dispatch('input');
    jest.advanceTimersByTime(1_000);

    const submit = await page.element('socialSignupForm').dispatch('submit');

    expect(submit.defaultPrevented).toBe(false);
    expect(page.element('loginId').value).toBe('social-user');
    expect(
      page.fetchCalls.some((call) => call.url === '/oauth/social/complete'),
    ).toBe(false);
  });

  it('submits empty optional password fields as successful native controls', async () => {
    const page = loadSignupScript(true);

    const submit = await page.element('socialSignupForm').dispatch('submit');

    expect(submit.defaultPrevented).toBe(false);
    expect(page.element('loginId').value).toBe('');
    expect(page.element('password').value).toBe('');
    expect(page.element('password').disabled).toBe(false);
    expect(page.element('passwordConfirm').value).toBe('');
    expect(page.element('passwordConfirm').disabled).toBe(false);
  });
});
