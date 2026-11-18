import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const publicPath = resolve(__dirname, '../../public');
const html = readFileSync(resolve(publicPath, 'portal.html'), 'utf8');
const script = readFileSync(resolve(publicPath, 'portal.js'), 'utf8');

interface UiEvent {
  type: string;
  target: ElementStub;
  preventDefault: jest.Mock;
}

class ElementStub {
  value = '';
  hidden = false;
  disabled = false;
  readOnly = false;
  required = false;
  checked = false;
  open = false;
  className = '';
  src = '';
  type = '';
  readonly dataset: Record<string, string> = {};
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly focus = jest.fn();
  readonly checkValidity = jest.fn(() => true);
  private text = '';
  private readonly listeners = new Map<
    string,
    Array<(event: UiEvent) => unknown>
  >();

  constructor(
    readonly tag: string,
    readonly id = '',
  ) {}

  set textContent(value: string) {
    this.text = value;
    this.children.length = 0;
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  set innerHTML(_value: string) {
    throw new Error('Portal must render API data as text, not HTML');
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  append(...children: ElementStub[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: ElementStub[]) {
    this.children.length = 0;
    this.text = '';
    this.append(...children);
  }

  querySelectorAll(tag: string): ElementStub[] {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }

  addEventListener(type: string, listener: (event: UiEvent) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  async dispatch(type: string) {
    const event: UiEvent = { type, target: this, preventDefault: jest.fn() };
    for (const listener of this.listeners.get(type) ?? [])
      await listener(event);
    return event;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }
}

interface FetchCall {
  url: string;
  options: {
    method: string;
    mode: string;
    credentials: string;
    redirect: string;
    cache: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  };
}

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

type UiResponse = ReturnType<typeof response>;

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

function overview(local = true, admin = false) {
  return {
    account: {
      id: 'owner-uuid',
      loginId: local ? 'teddy' : null,
      name: '홍길동',
      email: 'owner@example.com',
      hasLocalCredentials: local,
      isSuperAdmin: admin,
    },
    services: [
      {
        id: 'service-uuid',
        key: 'real-service',
        name: '실제 서비스',
        description: '서비스 설명',
        permission: { key: 'editor', label: '편집자' },
        grantedAt: '2026-11-01T00:00:00Z',
      },
    ],
    socialProviders: [
      {
        key: 'google',
        label: 'Google',
        linked: false,
        enabled: true,
        linkedAt: null as string | null,
      },
    ],
    csrfToken: 'csrf-from-me',
  };
}

interface Connection {
  provider: string;
  identityCount: number;
  canUnlink: boolean;
  reason: string | null;
  requiresProviderAuthentication: boolean;
}

function lifecycleOverview() {
  return {
    accountDeletion: {
      allowed: true,
      blockedReason: null as string | null,
      serviceDataPolicy: 'separate',
    },
    connections: [] as Connection[],
  };
}

function policiesOverview(accepted = true) {
  return {
    accepted,
    acceptedAt: accepted ? '2026-11-18T00:00:00Z' : null,
    termsVersion: 'terms-2026-11-18',
    privacyVersion: 'privacy-2026-11-18',
    policyDigest: 'a'.repeat(64),
    termsUrl: '/terms',
    privacyUrl: '/privacy',
  };
}

function loadPage(
  me: ReturnType<typeof overview> | Promise<UiResponse> = overview(),
  path = '/profile',
  lifecycle:
    | ReturnType<typeof lifecycleOverview>
    | Promise<UiResponse> = lifecycleOverview(),
  policies:
    | ReturnType<typeof policiesOverview>
    | Promise<UiResponse> = policiesOverview(),
) {
  const elements = new Map<string, ElementStub>();
  for (const match of html.matchAll(
    /<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g,
  )) {
    const [, tag, attributes, id] = match;
    const element = new ElementStub(tag, id);
    for (const name of ['hidden', 'disabled', 'readonly', 'required']) {
      if (new RegExp(`\\s${name}(?:\\s|$|=)`).test(attributes)) {
        if (name === 'readonly') element.readOnly = true;
        else element[name as 'hidden' | 'disabled' | 'required'] = true;
      }
    }
    for (const attribute of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
      element.setAttribute(attribute[1], attribute[2]);
    }
    elements.set(id, element);
  }
  const element = (id: string) => {
    const value = elements.get(id);
    if (!value) throw new Error(`Missing element: ${id}`);
    return value;
  };
  const document = {
    title: '',
    getElementById: element,
    createElement: (tag: string) => new ElementStub(tag),
  };
  const pending: Array<Promise<UiResponse>> = [
    me instanceof Promise ? me : Promise.resolve(response(me)),
  ];
  const lifecycleResponses: Array<Promise<UiResponse>> = [
    lifecycle instanceof Promise
      ? lifecycle
      : Promise.resolve(response(lifecycle)),
  ];
  const policyResponses: Array<Promise<UiResponse>> = [
    policies instanceof Promise
      ? policies
      : Promise.resolve(response(policies)),
  ];
  const calls: FetchCall[] = [];
  const assign = jest.fn();
  const fetch = (url: string, options: FetchCall['options']) => {
    calls.push({ url, options });
    if (url === '/api/portal/policies' && options.method === 'GET')
      return (
        policyResponses.shift() ?? Promise.resolve(response(policiesOverview()))
      );
    if (url === '/api/portal/lifecycle')
      return (
        lifecycleResponses.shift() ??
        Promise.resolve(response(lifecycleOverview()))
      );
    return pending.shift() ?? Promise.reject(new Error(`Unexpected ${url}`));
  };
  runInContext(
    script,
    createContext({
      document,
      fetch,
      setTimeout,
      clearTimeout,
      AbortController,
      URL,
      Intl,
      Date,
      window: {
        location: {
          pathname: path,
          origin: 'https://auth.example.com',
          assign,
        },
      },
    }),
    { filename: 'portal.js' },
  );
  return {
    element,
    calls,
    assign,
    document,
    queue: (value: UiResponse | Promise<UiResponse>) => {
      pending.push(Promise.resolve(value));
    },
    queueLifecycle: (value: UiResponse | Promise<UiResponse>) => {
      lifecycleResponses.push(Promise.resolve(value));
    },
    queuePolicies: (value: UiResponse | Promise<UiResponse>) => {
      policyResponses.push(Promise.resolve(value));
    },
    reject: (error: Error) => {
      pending.push(Promise.reject(error));
    },
  };
}

type Page = ReturnType<typeof loadPage>;

async function settle() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

async function input(page: Page, id: string, value: string) {
  page.element(id).value = value;
  await page.element(id).dispatch('input');
}

async function agreePolicies(page: Page) {
  for (const id of ['termsPolicyAccepted', 'privacyPolicyAccepted']) {
    page.element(id).checked = true;
    await page.element(id).dispatch('change');
  }
}

async function passwords(page: Page) {
  await input(page, 'currentPassword', 'old-password!');
  await input(page, 'newPassword', 'new-password!');
  await input(page, 'passwordConfirm', 'new-password!');
  jest.advanceTimersByTime(1000);
}

function expectPost(page: Page, index: number, path: string, body: unknown) {
  expect(page.calls[index]).toMatchObject({
    url: path,
    options: {
      method: 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'csrf-from-me',
      },
      body: JSON.stringify(body),
    },
  });
  const serialized = JSON.parse(
    page.calls[index].options.body ?? '{}',
  ) as object;
  expect(serialized).not.toHaveProperty('name');
  expect(serialized).not.toHaveProperty('accountId');
  expect(serialized).not.toHaveProperty('id');
}

function connectedLifecycle(overrides: Partial<Connection> = {}) {
  const lifecycle = lifecycleOverview();
  lifecycle.connections.push({
    provider: 'google',
    identityCount: 1,
    canUnlink: true,
    reason: null,
    requiresProviderAuthentication: false,
    ...overrides,
  });
  return lifecycle;
}

function lifecycleAction(page: Page, action = 'unlink') {
  const button = page
    .element('connectionList')
    .querySelectorAll('button')
    .find((element) => element.dataset.action === action);
  if (!button) throw new Error(`Missing lifecycle action: ${action}`);
  return button;
}

describe('portal UI', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('uses the shared A brand asset in the portal header', () => {
    expect(html).toMatch(
      /class="brand"[\s\S]*?<img\s+src="\/brand\/auth-logo-128\.png"/,
    );
    expect(html).not.toContain('src="/portal/assets/icons/shield-check.svg"');
    expect(
      readFileSync(resolve(publicPath, 'brand/auth-logo-128.png')).length,
    ).toBeGreaterThan(0);
  });

  it('loads only external whitelisted assets with no inline code or storage', () => {
    expect(html).toContain('href="/portal/assets/portal.css"');
    expect(html).toMatch(/src="\/portal\/assets\/portal.js" defer/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(script).not.toMatch(
      /localStorage|sessionStorage|document\.cookie|innerHTML|FormData/,
    );
    expect(html).not.toMatch(/name="(?:name|loginId|accountId)"/);
    const icons = readdirSync(resolve(publicPath, 'portal-icons'));
    for (const match of html.matchAll(
      /\/portal\/assets\/icons\/([^"/]+\.svg)/g,
    )) {
      expect(icons).toContain(match[1]);
    }
    expect(icons).toEqual(
      expect.arrayContaining(['check.svg', 'link.svg', 'LICENSE']),
    );
  });

  it('does not expose the profile, header or navigation while loading', async () => {
    const pending = deferred<UiResponse>();
    const page = loadPage(pending.promise);
    for (const id of [
      'portalContent',
      'portalHeader',
      'portalNav',
      'profileView',
    ]) {
      expect(page.element(id).hidden).toBe(true);
    }
    expect(page.element('loadingState').hidden).toBe(false);
    expect(page.calls[0]).toMatchObject({
      url: '/api/portal/me',
      options: { method: 'GET', credentials: 'same-origin', cache: 'no-store' },
    });
    pending.resolve(response(overview()));
    await settle();
    expect(page.element('loadingState').hidden).toBe(true);
    expect(page.element('portalContent').hidden).toBe(false);
    expect(page.element('profileView').hidden).toBe(false);
    expect(page.element('servicesView').hidden).toBe(true);
    expect(page.element('profileName').readOnly).toBe(true);
    expect(page.element('profileName').value).toBe('홍길동');
    expect(page.element('profileLoginId').readOnly).toBe(true);
    expect(page.element('profileLoginId').value).toBe('teddy');
    expect(page.element('profileNav').getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('uses only actual service names and permissions as text without invented links', async () => {
    const me = overview();
    me.services[0].name = '<img src=x onerror=attack()>';
    me.services[0].description = '<script>attack()</script>';
    me.services[0].permission.label = '실제 관리자 등급';
    const page = loadPage(me, '/');
    await settle();
    expect(page.element('servicesView').hidden).toBe(false);
    expect(page.element('profileView').hidden).toBe(true);
    expect(page.element('serviceList').textContent).toContain(
      me.services[0].name,
    );
    expect(page.element('serviceList').textContent).toContain(
      me.services[0].description,
    );
    expect(page.element('serviceList').textContent).toContain(
      '실제 관리자 등급',
    );
    expect(page.element('serviceList').querySelectorAll('a')).toHaveLength(0);
    expect(page.element('serviceList').children).toHaveLength(1);
    expect(page.element('serviceCount').textContent).toBe('1개');
    expect(page.element('servicesEmpty').hidden).toBe(true);
  });

  it('renders an honest empty state and an admin root navigation link on profile', async () => {
    const me = overview(true, true);
    me.services = [];
    const page = loadPage(me);
    await settle();
    expect(page.element('servicesEmpty').hidden).toBe(false);
    expect(page.element('serviceList').children).toHaveLength(0);
    expect(page.element('servicesNavLabel').textContent).toBe('관리 콘솔');
    expect(page.element('servicesNav').getAttribute('href')).toBe('/');
    expect(page.element('profileView').hidden).toBe(false);
  });

  it('serializes only current and new passwords for a local account with CSRF', async () => {
    const page = loadPage();
    await settle();
    await passwords(page);
    page.element('profileName').value = 'must not send';
    page.element('profileLoginId').value = 'must not change';
    page.queue(response({ reauthenticate: true }));
    await page.element('passwordForm').dispatch('submit');
    expectPost(page, 3, '/api/portal/password', {
      password: 'new-password!',
      passwordConfirm: 'new-password!',
      currentPassword: 'old-password!',
    });
    expect(JSON.parse(page.calls[3].options.body ?? '{}')).not.toHaveProperty(
      'loginId',
    );
    expect(page.element('passwordNotice').textContent).toContain('완료');
    expect(page.element('currentPassword').value).toBe('');
    expect(page.element('newPassword').value).toBe('');
    expect(page.element('passwordConfirm').value).toBe('');
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.element('savePasswordButton').disabled).toBe(true);
    jest.advanceTimersByTime(900);
    expect(page.assign).toHaveBeenCalledWith('/login');
  });

  it('requires one-second password and confirmation validation and resets it on edits', async () => {
    const page = loadPage();
    await settle();
    await input(page, 'currentPassword', 'old!');
    await input(page, 'newPassword', 'new-password!');
    await input(page, 'passwordConfirm', 'new-password!');
    jest.advanceTimersByTime(999);
    expect(page.element('savePasswordButton').disabled).toBe(true);
    jest.advanceTimersByTime(1);
    expect(page.element('savePasswordButton').disabled).toBe(false);
    await input(page, 'newPassword', 'another-password!');
    expect(page.element('savePasswordButton').disabled).toBe(true);
    jest.advanceTimersByTime(1000);
    expect(page.element('passwordConfirmFeedback').dataset.tone).toBe('error');
    await page.element('passwordForm').dispatch('submit');
    expect(page.calls).toHaveLength(3);
  });

  it.each(['short!', 'longpassword', '12345678'])(
    'rejects invalid password %j',
    async (password) => {
      const page = loadPage();
      await settle();
      await input(page, 'currentPassword', 'old!');
      await input(page, 'newPassword', password);
      await input(page, 'passwordConfirm', password);
      jest.advanceTimersByTime(1000);
      expect(page.element('savePasswordButton').disabled).toBe(true);
      expect(page.element('newPassword').getAttribute('aria-invalid')).toBe(
        'true',
      );
    },
  );

  it('registers local credentials for a social account only after a current ID check', async () => {
    const page = loadPage(overview(false));
    await settle();
    expect(page.element('editEmailButton').hidden).toBe(true);
    expect(page.element('currentPasswordField').hidden).toBe(true);
    expect(page.element('newLoginIdField').hidden).toBe(false);
    expect(page.element('passwordTitle').textContent).toContain('등록');
    await input(page, 'newLoginId', '  new-id  ');
    page.queue(response({ available: true }));
    await page.element('checkLoginIdButton').dispatch('click');
    expectPost(page, 3, '/api/signup/check-login-id', { loginId: 'new-id' });
    await passwords(page);
    expect(page.element('savePasswordButton').disabled).toBe(false);
    page.queue(response({ reauthenticate: true }));
    await page.element('passwordForm').dispatch('submit');
    expectPost(page, 4, '/api/portal/password', {
      password: 'new-password!',
      passwordConfirm: 'new-password!',
      loginId: 'new-id',
    });
    expect(JSON.parse(page.calls[4].options.body ?? '{}')).not.toHaveProperty(
      'currentPassword',
    );
    await page.element('editEmailButton').dispatch('click');
    expect(page.element('emailDialog').open).toBe(false);
  });

  it('invalidates a checked ID after edits and ignores stale availability responses', async () => {
    const page = loadPage(overview(false));
    await settle();
    await input(page, 'newLoginId', 'first-id');
    const pending = deferred<UiResponse>();
    page.queue(pending.promise);
    const checking = page.element('checkLoginIdButton').dispatch('click');
    expect(page.element('checkLoginIdButton').disabled).toBe(true);
    expect(page.element('newLoginId').disabled).toBe(false);
    await input(page, 'newLoginId', 'second-id');
    pending.resolve(response({ available: true }));
    await checking;
    await passwords(page);
    expect(page.element('savePasswordButton').disabled).toBe(true);
    expect(page.element('loginIdFeedback').textContent).toBe('');
    page.queue(response({ available: true }));
    await page.element('checkLoginIdButton').dispatch('click');
    expect(page.element('savePasswordButton').disabled).toBe(false);
    await input(page, 'newLoginId', 'third-id');
    expect(page.element('savePasswordButton').disabled).toBe(true);
  });

  it('sends the exact two-step email contract without serializing profile fields', async () => {
    const page = loadPage();
    await settle();
    await page.element('editEmailButton').dispatch('click');
    expect(page.element('emailDialog').open).toBe(true);
    await input(page, 'emailCurrentPassword', 'current!');
    await input(page, 'newEmail', '  new@example.com  ');
    page.queue(response({ verificationId: 'verification-uuid' }));
    await page.element('emailStartForm').dispatch('submit');
    expectPost(page, 3, '/api/portal/email/start', {
      currentPassword: 'current!',
      email: 'new@example.com',
    });
    expect(page.element('emailCurrentPassword').value).toBe('');
    expect(page.element('emailStartForm').hidden).toBe(true);
    expect(page.element('emailCompleteForm').hidden).toBe(false);
    await input(page, 'emailCode', 'A1B2C3');
    page.queue(response({ reauthenticate: true }));
    await page.element('emailCompleteForm').dispatch('submit');
    expectPost(page, 4, '/api/portal/email/complete', {
      verificationId: 'verification-uuid',
      code: 'A1B2C3',
    });
    expect(page.element('emailNotice').textContent).toContain('완료');
    jest.advanceTimersByTime(900);
    expect(page.assign).toHaveBeenCalledWith('/login');
  });

  it('clears verification and secrets when the email modal is cancelled or restarted', async () => {
    const page = loadPage();
    await settle();
    await page.element('editEmailButton').dispatch('click');
    await input(page, 'emailCurrentPassword', 'current!');
    await input(page, 'newEmail', 'new@example.com');
    page.queue(response({ verificationId: 'old-verification' }));
    await page.element('emailStartForm').dispatch('submit');
    await page.element('restartEmailButton').dispatch('click');
    expect(page.element('emailCurrentPassword').value).toBe('');
    expect(page.element('newEmail').value).toBe('');
    expect(page.element('completeEmailButton').disabled).toBe(true);
    const event = await page.element('emailDialog').dispatch('cancel');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(page.element('emailDialog').open).toBe(false);
  });

  it('blocks invalid email and incomplete OTP and keeps the email request single-flight', async () => {
    const page = loadPage();
    await settle();
    await page.element('editEmailButton').dispatch('click');
    await input(page, 'emailCurrentPassword', 'current!');
    page.element('newEmail').checkValidity.mockReturnValue(false);
    await input(page, 'newEmail', 'not-an-email');
    await page.element('emailStartForm').dispatch('submit');
    expect(page.calls).toHaveLength(3);
    page.element('newEmail').checkValidity.mockReturnValue(true);
    await input(page, 'newEmail', 'new@example.com');
    const pending = deferred<UiResponse>();
    page.queue(pending.promise);
    const sending = page.element('emailStartForm').dispatch('submit');
    expect(page.element('sendEmailButton').disabled).toBe(true);
    expect(page.element('closeEmailButton').disabled).toBe(true);
    await page.element('emailStartForm').dispatch('submit');
    await page.element('closeEmailButton').dispatch('click');
    expect(page.calls).toHaveLength(4);
    expect(page.element('emailDialog').open).toBe(true);
    pending.resolve(response({ verificationId: 'verification-uuid' }));
    await sending;
    await input(page, 'emailCode', '123');
    await page.element('emailCompleteForm').dispatch('submit');
    expect(page.calls).toHaveLength(4);
    expect(page.element('completeEmailButton').disabled).toBe(true);
  });

  it('offers an accessible reauthentication action inside an open email modal', async () => {
    const page = loadPage();
    await settle();
    await page.element('editEmailButton').dispatch('click');
    await input(page, 'emailCurrentPassword', 'current!');
    await input(page, 'newEmail', 'new@example.com');
    page.queue(response({ code: 'reauthentication_required' }, 403));
    await page.element('emailStartForm').dispatch('submit');
    expect(page.element('emailReauthButton').hidden).toBe(false);
    expect(page.element('emailReauthButton').getAttribute('href')).toBe(
      '/login?reauth=1',
    );
    expect(page.element('sendEmailButton').disabled).toBe(true);
    expect(page.element('closeEmailButton').disabled).toBe(false);
  });

  it('does not serialize credentials changed without a validation event', async () => {
    const page = loadPage();
    await settle();
    await passwords(page);
    page.element('passwordConfirm').value = 'different!';
    await page.element('passwordForm').dispatch('submit');
    expect(page.calls).toHaveLength(3);
  });

  it('recovers from a network error without losing the ability to retry', async () => {
    const page = loadPage(overview(false));
    await settle();
    await input(page, 'newLoginId', 'new-id');
    page.reject(new Error('Network unavailable'));
    await page.element('checkLoginIdButton').dispatch('click');
    expect(page.element('loginIdFeedback').dataset.tone).toBe('error');
    expect(page.element('checkLoginIdButton').disabled).toBe(false);
    page.queue(response({ available: true }));
    await page.element('checkLoginIdButton').dispatch('click');
    expect(page.element('loginIdFeedback').dataset.tone).toBe('success');
  });

  it.each(['null', '[]', '<html>Not JSON</html>'])(
    'fails closed for malformed overview response %s',
    async (raw) => {
      const page = loadPage(
        Promise.resolve({ ok: true, status: 200, text: async () => raw }),
      );
      await settle();
      expect(page.element('portalContent').hidden).toBe(true);
      expect(page.element('pageNotice').dataset.tone).toBe('error');
      expect(page.element('recoveryActions').hidden).toBe(false);
    },
  );

  it('locks mutation controls during fetch and does not submit a second request', async () => {
    const page = loadPage();
    await settle();
    await passwords(page);
    const pending = deferred<UiResponse>();
    page.queue(pending.promise);
    const submitting = page.element('passwordForm').dispatch('submit');
    expect(page.element('savePasswordButton').disabled).toBe(true);
    expect(page.element('logoutButton').disabled).toBe(true);
    expect(page.element('newPassword').disabled).toBe(true);
    expect(page.element('passwordForm').getAttribute('aria-busy')).toBe('true');
    await page.element('passwordForm').dispatch('submit');
    expect(page.calls).toHaveLength(4);
    pending.resolve(
      response({ message: '현재 비밀번호가 올바르지 않습니다.' }, 400),
    );
    await submitting;
    expect(page.element('passwordNotice').dataset.tone).toBe('error');
    expect(page.element('newPassword').disabled).toBe(false);
    expect(page.element('savePasswordButton').disabled).toBe(false);
  });

  it('offers reauthentication after a protected 403 without retrying the mutation', async () => {
    const page = loadPage();
    await settle();
    await passwords(page);
    page.queue(response({ code: 'reauthentication_required' }, 403));
    await page.element('passwordForm').dispatch('submit');
    expect(page.element('reauthButton').hidden).toBe(false);
    expect(page.element('reauthButton').getAttribute('href')).toBe(
      '/login?reauth=1',
    );
    expect(page.element('savePasswordButton').disabled).toBe(true);
    expect(page.assign).not.toHaveBeenCalled();
    await page.element('passwordForm').dispatch('submit');
    expect(page.calls).toHaveLength(4);
  });

  it('posts logout with CSRF and redirects to login', async () => {
    const page = loadPage();
    await settle();
    page.queue(response({}));
    await page.element('logoutButton').dispatch('click');
    expectPost(page, 3, '/api/portal/logout', {});
    expect(page.assign).toHaveBeenCalledWith('/login');
  });

  it('redirects a 401 from loading or a mutation to login', async () => {
    const loading = loadPage(Promise.resolve(response({}, 401)));
    await settle();
    expect(loading.assign).toHaveBeenCalledWith('/login');
    expect(loading.element('portalContent').hidden).toBe(true);
    const page = loadPage();
    await settle();
    page.queue(response({}, 401));
    await page.element('logoutButton').dispatch('click');
    expect(page.assign).toHaveBeenCalledWith('/login');
  });

  it('keeps an invalid current password on the password form and allows correction', async () => {
    const page = loadPage();
    await settle();
    await passwords(page);
    page.queue(
      response(
        {
          code: 'invalid_current_password',
          message: '현재 비밀번호가 올바르지 않습니다.',
        },
        401,
      ),
    );
    await page.element('passwordForm').dispatch('submit');
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.element('passwordNotice').textContent).toBe(
      '현재 비밀번호가 올바르지 않습니다.',
    );
    expect(page.element('passwordNotice').dataset.tone).toBe('error');
    expect(page.element('savePasswordButton').disabled).toBe(false);
    expect(page.element('reauthButton').hidden).toBe(true);
    await input(page, 'currentPassword', 'correct-password!');
    page.queue(response({ reauthenticate: true }));
    await page.element('passwordForm').dispatch('submit');
    expectPost(page, 4, '/api/portal/password', {
      password: 'new-password!',
      passwordConfirm: 'new-password!',
      currentPassword: 'correct-password!',
    });
    jest.advanceTimersByTime(900);
    expect(page.assign).toHaveBeenCalledWith('/login');
  });

  it('keeps an invalid current password inside the email modal and allows correction', async () => {
    const page = loadPage();
    await settle();
    await page.element('editEmailButton').dispatch('click');
    await input(page, 'emailCurrentPassword', 'wrong-password!');
    await input(page, 'newEmail', 'new@example.com');
    page.queue(
      response(
        {
          code: 'invalid_current_password',
          message: '현재 비밀번호가 올바르지 않습니다.',
        },
        401,
      ),
    );
    await page.element('emailStartForm').dispatch('submit');
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.element('emailDialog').open).toBe(true);
    expect(page.element('emailStartForm').hidden).toBe(false);
    expect(page.element('emailCompleteForm').hidden).toBe(true);
    expect(page.element('emailNotice').textContent).toBe(
      '현재 비밀번호가 올바르지 않습니다.',
    );
    expect(page.element('emailNotice').dataset.tone).toBe('error');
    expect(page.element('sendEmailButton').disabled).toBe(false);
    expect(page.element('emailReauthButton').hidden).toBe(true);
    await input(page, 'emailCurrentPassword', 'correct-password!');
    page.queue(response({ verificationId: 'verification-uuid' }));
    await page.element('emailStartForm').dispatch('submit');
    expectPost(page, 4, '/api/portal/email/start', {
      currentPassword: 'correct-password!',
      email: 'new@example.com',
    });
    expect(page.element('emailCompleteForm').hidden).toBe(false);
  });

  it('keeps an invalid email verification inside the modal and retries the same verification', async () => {
    const page = loadPage();
    await settle();
    await page.element('editEmailButton').dispatch('click');
    await input(page, 'emailCurrentPassword', 'current!');
    await input(page, 'newEmail', 'new@example.com');
    page.queue(response({ verificationId: 'verification-uuid' }));
    await page.element('emailStartForm').dispatch('submit');
    await input(page, 'emailCode', 'WRONG1');
    page.queue(
      response(
        {
          code: 'invalid_email_verification',
          message: '인증번호가 올바르지 않거나 만료되었습니다.',
        },
        401,
      ),
    );
    await page.element('emailCompleteForm').dispatch('submit');
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.element('emailDialog').open).toBe(true);
    expect(page.element('emailCompleteForm').hidden).toBe(false);
    expect(page.element('emailNotice').textContent).toBe(
      '인증번호가 올바르지 않거나 만료되었습니다.',
    );
    expect(page.element('emailNotice').dataset.tone).toBe('error');
    expect(page.element('completeEmailButton').disabled).toBe(false);
    expect(page.element('emailReauthButton').hidden).toBe(true);
    await input(page, 'emailCode', 'A1B2C3');
    page.queue(response({ reauthenticate: true }));
    await page.element('emailCompleteForm').dispatch('submit');
    expectPost(page, 5, '/api/portal/email/complete', {
      verificationId: 'verification-uuid',
      code: 'A1B2C3',
    });
    jest.advanceTimersByTime(900);
    expect(page.assign).toHaveBeenCalledWith('/login');
  });

  it.each(['invalid_current_password', 'invalid_email_verification'])(
    'still redirects a /me 401 with code %s',
    async (code) => {
      const page = loadPage(Promise.resolve(response({ code }, 401)));
      await settle();
      expect(page.assign).toHaveBeenCalledWith('/login');
      expect(page.element('portalContent').hidden).toBe(true);
    },
  );

  it.each(['session_expired', 'invalid_email_verification', undefined])(
    'redirects an unrelated password-form 401 with code %s',
    async (code) => {
      const page = loadPage();
      await settle();
      await passwords(page);
      page.queue(response({ code, message: 'Login is required' }, 401));
      await page.element('passwordForm').dispatch('submit');
      expect(page.assign).toHaveBeenCalledWith('/login');
      expect(page.element('savePasswordButton').disabled).toBe(true);
    },
  );

  it('redirects an expired session even if its 401 response is not JSON', async () => {
    const page = loadPage(
      Promise.resolve({
        ok: false,
        status: 401,
        text: async () => '<html>Login required</html>',
      }),
    );
    await settle();
    expect(page.assign).toHaveBeenCalledWith('/login');
  });

  it('keeps account content hidden after a failed load and supports retry', async () => {
    const page = loadPage(
      Promise.resolve(
        response({ message: '잠시 후 다시 시도해 주세요.' }, 503),
      ),
    );
    await settle();
    expect(page.element('portalContent').hidden).toBe(true);
    expect(page.element('pageNotice').dataset.tone).toBe('error');
    expect(page.element('recoveryActions').hidden).toBe(false);
    page.queue(response(overview()));
    await page.element('retryButton').dispatch('click');
    expect(page.element('portalContent').hidden).toBe(false);
  });

  it('hides unconfigured providers and renders unavailable linked providers without buttons', async () => {
    const me = overview();
    me.socialProviders = [
      {
        key: 'google',
        label: 'Google',
        enabled: false,
        linked: false,
        linkedAt: null,
      },
      {
        key: 'kakao',
        label: 'Kakao',
        enabled: false,
        linked: true,
        linkedAt: '2026-11-01T00:00:00Z',
      },
      {
        key: 'naver',
        label: 'Naver',
        enabled: true,
        linked: true,
        linkedAt: null,
      },
      {
        key: '../../injected',
        label: 'Unsafe',
        enabled: true,
        linked: false,
        linkedAt: null,
      },
    ];
    const page = loadPage(me);
    await settle();
    const list = page.element('providerList');
    expect(list.children).toHaveLength(2);
    expect(list.textContent).toContain('Kakao');
    expect(list.textContent).toContain('Naver');
    expect(list.textContent).not.toContain('Google');
    expect(list.textContent).not.toContain('Unsafe');
    expect(list.querySelectorAll('button')).toHaveLength(0);
    expect(list.textContent).toContain('연결됨');
  });

  it('shows no provider actions when all providers are unconfigured', async () => {
    const me = overview();
    me.socialProviders[0].enabled = false;
    const page = loadPage(me);
    await settle();
    expect(page.element('providerList').children).toHaveLength(0);
    expect(page.element('providersEmpty').hidden).toBe(false);
  });

  it('links an enabled provider through a protected POST and same-origin Auth navigation', async () => {
    const page = loadPage();
    await settle();
    page.queue(
      response({
        redirectUrl: '/oauth/social/google/navigate?transaction=opaque',
      }),
    );
    const button = page.element('providerList').querySelectorAll('button')[0];
    await button.dispatch('click');
    expectPost(page, 3, '/api/portal/social/google/link', {});
    expect(page.assign).toHaveBeenCalledWith(
      'https://auth.example.com/oauth/social/google/navigate?transaction=opaque',
    );
  });

  it.each([
    'https://attacker.example/link',
    '//attacker.example/link',
    'javascript:alert(1)',
    '',
  ])('rejects unsafe provider redirect %j', async (redirectUrl) => {
    const page = loadPage();
    await settle();
    page.queue(response({ redirectUrl }));
    await page
      .element('providerList')
      .querySelectorAll('button')[0]
      .dispatch('click');
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.element('pageNotice').dataset.tone).toBe('error');
  });

  it('loads lifecycle after /me only on the profile route', async () => {
    const pending = deferred<UiResponse>();
    const page = loadPage(pending.promise);
    expect(page.calls.map((call) => call.url)).toEqual(['/api/portal/me']);
    pending.resolve(response(overview()));
    await settle();
    expect(page.calls.map((call) => call.url)).toEqual([
      '/api/portal/me',
      '/api/portal/lifecycle',
      '/api/portal/policies',
    ]);
    expect(page.calls[1].options).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const services = loadPage(overview(), '/');
    await settle();
    expect(services.calls.map((call) => call.url)).toEqual(['/api/portal/me']);
    expect(services.element('lifecycleSection').hidden).toBe(true);
  });

  it('keeps lifecycle commands disabled while loading and supports an isolated retry', async () => {
    const pending = deferred<UiResponse>();
    const page = loadPage(overview(), '/profile', pending.promise);
    await settle();
    expect(page.element('lifecycleSection').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(page.element('withdrawButton').disabled).toBe(true);
    pending.resolve(response({ message: 'Unavailable' }, 503));
    await settle();
    expect(page.element('portalContent').hidden).toBe(false);
    expect(page.element('lifecycleNotice').dataset.tone).toBe('error');
    expect(page.element('withdrawButton').disabled).toBe(true);
    expect(page.element('retryLifecycleButton').hidden).toBe(false);
    page.queueLifecycle(response(connectedLifecycle()));
    await page.element('retryLifecycleButton').dispatch('click');
    expect(lifecycleAction(page).disabled).toBe(false);
    expect(
      page.calls.filter((call) => call.url === '/api/portal/me'),
    ).toHaveLength(1);
  });

  it('requires current password and sends a bound UNLINK command with CSRF', async () => {
    const page = loadPage(overview(), '/profile', connectedLifecycle());
    await settle();
    await lifecycleAction(page).dispatch('click');
    expect(page.element('lifecycleDialog').open).toBe(true);
    expect(page.element('lifecyclePasswordField').hidden).toBe(false);
    expect(page.element('lifecyclePassword').value).toBe('');
    expect(page.element('lifecyclePassword').required).toBe(true);
    expect(page.element('withdrawConfirmationField').hidden).toBe(true);
    expect(page.element('confirmLifecycleButton').disabled).toBe(true);
    await input(page, 'lifecyclePassword', ' Current-password! ');
    page.element('withdrawConfirmation').value = 'DELETE';
    page.queue(
      response({
        ok: true,
        reauthenticate: true,
        pendingProviderRevocations: ['google'],
      }),
    );
    await page.element('lifecycleForm').dispatch('submit');
    expectPost(page, 3, '/api/portal/social/google/unlink', {
      confirmation: 'UNLINK',
      currentPassword: ' Current-password! ',
    });
    expect(page.element('lifecyclePassword').value).toBe('');
    expect(page.element('lifecycleNoticeInDialog').textContent).toContain(
      '철회',
    );
    jest.advanceTimersByTime(900);
    expect(page.assign).toHaveBeenCalledWith('/login');
  });

  it('honors an explicit lifecycle actor password requirement without changing /me', async () => {
    const lifecycle = {
      ...connectedLifecycle(),
      actor: { requiresCurrentPassword: true },
    };
    const page = loadPage(overview(false), '/profile', lifecycle);
    await settle();
    await lifecycleAction(page).dispatch('click');
    expect(page.element('lifecyclePasswordField').hidden).toBe(false);
    expect(page.element('confirmLifecycleButton').disabled).toBe(true);
  });

  it('requires both current password and DELETE for local-account withdrawal', async () => {
    const page = loadPage();
    await settle();
    await page.element('withdrawButton').dispatch('click');
    await input(page, 'withdrawConfirmation', 'DELETE');
    await page.element('lifecycleForm').dispatch('submit');
    expect(page.calls).toHaveLength(3);
    await input(page, 'lifecyclePassword', ' Current! ');
    page.queue(response({ withdrawn: true, pendingProviderRevocations: 0 }));
    await page.element('lifecycleForm').dispatch('submit');
    expectPost(page, 3, '/api/portal/withdraw', {
      confirmation: 'DELETE',
      currentPassword: ' Current! ',
    });
    expect(page.element('lifecyclePassword').value).toBe('');
  });

  it('does not require or serialize a hidden current password for social-only unlink', async () => {
    const page = loadPage(overview(false), '/profile', connectedLifecycle());
    await settle();
    await lifecycleAction(page).dispatch('click');
    expect(page.element('lifecyclePasswordField').hidden).toBe(true);
    expect(page.element('lifecyclePassword').disabled).toBe(true);
    expect(page.element('lifecyclePassword').required).toBe(false);
    page.element('lifecyclePassword').value = 'must-not-send';
    page.queue(
      response({
        ok: true,
        reauthenticate: true,
        pendingProviderRevocations: [],
      }),
    );
    await page.element('lifecycleForm').dispatch('submit');
    expectPost(page, 3, '/api/portal/social/google/unlink', {
      confirmation: 'UNLINK',
    });
  });

  it('requires a manually entered exact DELETE before withdrawing only Auth data', async () => {
    const page = loadPage(overview(false));
    await settle();
    await page.element('withdrawButton').dispatch('click');
    expect(page.element('withdrawConfirmation').value).toBe('');
    expect(page.element('withdrawConfirmation').focus).toHaveBeenCalled();
    expect(page.element('lifecycleDialogDescription').textContent).toContain(
      'Todo',
    );
    for (const value of ['', 'delete', ' DELETE', 'DELETE ']) {
      await input(page, 'withdrawConfirmation', value);
      await page.element('lifecycleForm').dispatch('submit');
      expect(page.calls).toHaveLength(3);
      expect(page.element('confirmLifecycleButton').disabled).toBe(true);
    }
    await input(page, 'withdrawConfirmation', 'DELETE');
    page.queue(response({ withdrawn: true, pendingProviderRevocations: 1 }));
    await page.element('lifecycleForm').dispatch('submit');
    expectPost(page, 3, '/api/portal/withdraw', { confirmation: 'DELETE' });
    expect(page.element('withdrawConfirmation').value).toBe('');
    expect(page.element('profileEmail').value).toBe('');
    expect(page.element('portalContent').hidden).toBe(true);
    expect(page.element('lifecycleNoticeInDialog').textContent).toContain(
      '완료',
    );
    jest.advanceTimersByTime(900);
    expect(page.assign).toHaveBeenCalledWith('/about');
  });

  it.each(['last_superadmin', 'last_active_superadmin'])(
    'blocks the last login method and %s withdrawal with specific guidance',
    async (blockedReason) => {
      const lifecycle = connectedLifecycle({
        canUnlink: false,
        reason: 'last_login_method',
        requiresProviderAuthentication: true,
      });
      lifecycle.accountDeletion.allowed = false;
      lifecycle.accountDeletion.blockedReason = blockedReason;
      const page = loadPage(overview(false, true), '/profile', lifecycle);
      await settle();
      expect(lifecycleAction(page).disabled).toBe(true);
      expect(page.element('connectionList').textContent).toContain(
        '로그인 수단',
      );
      expect(page.element('withdrawButton').disabled).toBe(true);
      expect(page.element('withdrawBlockedReason').textContent).toContain(
        '최고 관리자',
      );
      await lifecycleAction(page).dispatch('click');
      await page.element('withdrawButton').dispatch('click');
      expect(page.element('lifecycleDialog').open).toBe(false);
      expect(page.calls).toHaveLength(3);
    },
  );

  it.each([
    'provider_reauthentication_required',
    'provider_revocation_unavailable',
  ])(
    'explains the withdrawal blocker %s without suggesting completion',
    async (blockedReason) => {
      const lifecycle = lifecycleOverview();
      lifecycle.accountDeletion = {
        ...lifecycle.accountDeletion,
        allowed: false,
        blockedReason,
      };
      const page = loadPage(overview(), '/profile', lifecycle);
      await settle();
      expect(page.element('withdrawButton').disabled).toBe(true);
      expect(page.element('withdrawBlockedReason').textContent).toContain(
        blockedReason === 'provider_reauthentication_required'
          ? '다시 인증'
          : '철회',
      );
    },
  );

  it('reconnects a provider through CSRF and the existing same-origin navigation boundary', async () => {
    const page = loadPage(
      overview(false),
      '/profile',
      connectedLifecycle({
        canUnlink: false,
        requiresProviderAuthentication: true,
      }),
    );
    await settle();
    page.queue(
      response({
        redirectUrl: '/oauth/social/google/navigate?transaction=reconnect',
      }),
    );
    await lifecycleAction(page, 'reconnect').dispatch('click');
    expectPost(page, 3, '/api/portal/social/google/reconnect', {});
    expect(page.assign).toHaveBeenCalledWith(
      'https://auth.example.com/oauth/social/google/navigate?transaction=reconnect',
    );
  });

  it.each(['google', 'kakao', 'naver'])(
    'suppresses lifecycle OAuth actions for disabled linked %s even when provider authentication is required',
    async (provider) => {
      const me = overview(false);
      me.socialProviders = [
        {
          key: provider,
          label: provider,
          linked: true,
          enabled: false,
          linkedAt: null,
        },
      ];
      const page = loadPage(
        me,
        '/profile',
        connectedLifecycle({
          provider,
          canUnlink: false,
          requiresProviderAuthentication: true,
        }),
      );
      await settle();
      expect(page.element('connectionList').textContent).toContain(
        { google: 'Google', kakao: 'Kakao', naver: 'Naver' }[provider],
      );
      expect(
        page
          .element('connectionList')
          .querySelectorAll('button')
          .some((button) => button.dataset.action === 'reconnect'),
      ).toBe(false);
      expect(
        page.element('providerList').querySelectorAll('button'),
      ).toHaveLength(0);
      expect(
        page.calls.filter((call) => call.options.method === 'POST'),
      ).toHaveLength(0);
      expect(page.assign).not.toHaveBeenCalled();
    },
  );

  it('fails closed for lifecycle reconnect when /me contains no provider configuration', async () => {
    const me = overview(false);
    me.socialProviders = [];
    const page = loadPage(
      me,
      '/profile',
      connectedLifecycle({ requiresProviderAuthentication: true }),
    );
    await settle();
    expect(
      page
        .element('connectionList')
        .querySelectorAll('button')
        .some((button) => button.dataset.action === 'reconnect'),
    ).toBe(false);
  });

  it.each([
    'https://attacker.example/reconnect',
    '//attacker.example',
    'javascript:alert(1)',
    '',
  ])('rejects unsafe reconnect navigation %j', async (redirectUrl) => {
    const page = loadPage(
      overview(false),
      '/profile',
      connectedLifecycle({ requiresProviderAuthentication: true }),
    );
    await settle();
    page.queue(response({ redirectUrl }));
    await lifecycleAction(page, 'reconnect').dispatch('click');
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.element('lifecycleNotice').dataset.tone).toBe('error');
  });

  it.each(['unlink', 'withdraw'])(
    'keeps wrong-password 401 in the %s modal and permits correction',
    async (command) => {
      const page = loadPage(overview(), '/profile', connectedLifecycle());
      await settle();
      if (command === 'unlink') await lifecycleAction(page).dispatch('click');
      else {
        await page.element('withdrawButton').dispatch('click');
        await input(page, 'withdrawConfirmation', 'DELETE');
      }
      await input(page, 'lifecyclePassword', 'wrong!');
      page.queue(
        response(
          {
            code: 'invalid_current_password',
            message: '현재 비밀번호가 올바르지 않습니다.',
          },
          401,
        ),
      );
      await page.element('lifecycleForm').dispatch('submit');
      expect(page.assign).not.toHaveBeenCalled();
      expect(page.element('lifecycleDialog').open).toBe(true);
      expect(page.element('lifecycleNoticeInDialog').dataset.tone).toBe(
        'error',
      );
      expect(page.element('confirmLifecycleButton').disabled).toBe(false);
      await input(page, 'lifecyclePassword', 'correct!');
      page.queue(
        response(
          command === 'unlink'
            ? { ok: true, reauthenticate: true }
            : { withdrawn: true },
        ),
      );
      await page.element('lifecycleForm').dispatch('submit');
      expectPost(
        page,
        4,
        command === 'unlink'
          ? '/api/portal/social/google/unlink'
          : '/api/portal/withdraw',
        {
          confirmation: command === 'unlink' ? 'UNLINK' : 'DELETE',
          currentPassword: 'correct!',
        },
      );
    },
  );

  it('offers shared reauthentication inside the lifecycle dialog after a protected 403', async () => {
    const page = loadPage(overview(false));
    await settle();
    await page.element('withdrawButton').dispatch('click');
    await input(page, 'withdrawConfirmation', 'DELETE');
    page.queue(response({ code: 'reauthentication_required' }, 403));
    await page.element('lifecycleForm').dispatch('submit');
    expect(page.element('reauthButton').hidden).toBe(false);
    expect(page.element('lifecycleReauthButton').hidden).toBe(false);
    expect(page.element('lifecycleReauthButton').getAttribute('href')).toBe(
      '/login?reauth=1',
    );
    expect(page.element('confirmLifecycleButton').disabled).toBe(true);
    expect(page.element('withdrawConfirmation').value).toBe('');
    expect(page.element('closeLifecycleButton').disabled).toBe(false);
    expect(page.assign).not.toHaveBeenCalled();
    await page.element('closeLifecycleButton').dispatch('click');
    expect(page.element('reauthButton').focus).toHaveBeenCalled();
  });

  it('redirects expired lifecycle sessions without claiming completion', async () => {
    const page = loadPage(overview(false));
    await settle();
    await page.element('withdrawButton').dispatch('click');
    await input(page, 'withdrawConfirmation', 'DELETE');
    page.queue(response({ code: 'session_expired' }, 401));
    await page.element('lifecycleForm').dispatch('submit');
    expect(page.assign).toHaveBeenCalledWith('/login');
    expect(page.element('withdrawConfirmation').value).toBe('');
    expect(page.element('lifecycleNoticeInDialog').dataset.tone).not.toBe(
      'success',
    );
  });

  it('blocks duplicate commands and Escape while busy, then clears secrets on cancellation', async () => {
    const page = loadPage(overview(), '/profile', connectedLifecycle());
    await settle();
    await lifecycleAction(page).dispatch('click');
    await input(page, 'lifecyclePassword', 'current!');
    const pending = deferred<UiResponse>();
    page.queue(pending.promise);
    const submitting = page.element('lifecycleForm').dispatch('submit');
    expect(page.element('lifecycleDialog').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(page.element('confirmLifecycleButton').disabled).toBe(true);
    expect(page.element('closeLifecycleButton').disabled).toBe(true);
    const cancel = await page.element('lifecycleDialog').dispatch('cancel');
    expect(cancel.preventDefault).toHaveBeenCalled();
    await page.element('closeLifecycleButton').dispatch('click');
    await page.element('lifecycleForm').dispatch('submit');
    await page.element('withdrawButton').dispatch('click');
    await page.element('logoutButton').dispatch('click');
    expect(page.calls).toHaveLength(4);
    expect(page.element('lifecycleDialog').open).toBe(true);
    pending.resolve(response({ message: 'Try again' }, 503));
    await submitting;
    expect(page.element('lifecycleDialog').open).toBe(true);
    expect(page.element('confirmLifecycleButton').disabled).toBe(false);
    await page.element('lifecycleDialog').dispatch('cancel');
    expect(page.element('lifecycleDialog').open).toBe(false);
    expect(page.element('lifecyclePassword').value).toBe('');
    expect(lifecycleAction(page).focus).toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { accountDeletion: { allowed: true } },
    {
      ...lifecycleOverview(),
      connections: [
        { ...connectedLifecycle().connections[0], provider: '../injected' },
      ],
    },
  ])(
    'fails closed on malformed lifecycle metadata %j while preserving profile functions',
    async (payload) => {
      const page = loadPage(
        overview(),
        '/profile',
        Promise.resolve(response(payload)),
      );
      await settle();
      expect(page.element('portalContent').hidden).toBe(false);
      expect(page.element('editEmailButton').disabled).toBe(false);
      expect(page.element('withdrawButton').disabled).toBe(true);
      expect(page.element('connectionList').children).toHaveLength(0);
      expect(page.element('lifecycleNotice').dataset.tone).toBe('error');
      await page.element('withdrawButton').dispatch('click');
      expect(page.element('lifecycleDialog').open).toBe(false);
    },
  );

  it.each([401, 403])(
    'uses shared recovery for lifecycle GET status %s',
    async (status) => {
      const page = loadPage(
        overview(),
        '/profile',
        Promise.resolve(
          response({ code: 'reauthentication_required' }, status),
        ),
      );
      await settle();
      expect(page.element('withdrawButton').disabled).toBe(true);
      expect(page.element('retryLifecycleButton').hidden).toBe(true);
      if (status === 401) expect(page.assign).toHaveBeenCalledWith('/login');
      else expect(page.element('reauthButton').hidden).toBe(false);
    },
  );

  it('supports retry after a network failure without claiming a completed withdrawal', async () => {
    const page = loadPage(overview(false));
    await settle();
    await page.element('withdrawButton').dispatch('click');
    await input(page, 'withdrawConfirmation', 'DELETE');
    page.reject(new Error('Network unavailable'));
    await page.element('lifecycleForm').dispatch('submit');
    expect(page.element('lifecycleNoticeInDialog').dataset.tone).toBe('error');
    expect(page.element('confirmLifecycleButton').disabled).toBe(false);
    expect(page.assign).not.toHaveBeenCalled();
    page.queue(response({ withdrawn: true, pendingProviderRevocations: 0 }));
    await page.element('lifecycleForm').dispatch('submit');
    expectPost(page, 4, '/api/portal/withdraw', { confirmation: 'DELETE' });
  });

  it('clears every form secret when a lifecycle command succeeds', async () => {
    const page = loadPage(overview(), '/profile', connectedLifecycle());
    await settle();
    for (const id of [
      'currentPassword',
      'newPassword',
      'passwordConfirm',
      'emailCurrentPassword',
      'emailCode',
    ])
      page.element(id).value = 'secret';
    await lifecycleAction(page).dispatch('click');
    await input(page, 'lifecyclePassword', 'current!');
    page.queue(
      response({
        ok: true,
        reauthenticate: true,
        pendingProviderRevocations: 0,
      }),
    );
    await page.element('lifecycleForm').dispatch('submit');
    for (const id of [
      'currentPassword',
      'newPassword',
      'passwordConfirm',
      'emailCurrentPassword',
      'emailCode',
      'lifecyclePassword',
      'withdrawConfirmation',
    ])
      expect(page.element(id).value).toBe('');
  });

  it('starts cancellation and reopening with no default secrets or prefilled DELETE', async () => {
    const page = loadPage(overview(false));
    await settle();
    await page.element('withdrawButton').dispatch('click');
    await input(page, 'withdrawConfirmation', 'DELETE');
    await page.element('cancelLifecycleButton').dispatch('click');
    await page.element('withdrawButton').dispatch('click');
    expect(page.element('withdrawConfirmation').value).toBe('');
    expect(page.element('lifecyclePassword').value).toBe('');
    expect(page.element('confirmLifecycleButton').disabled).toBe(true);
    expect(
      page.element('lifecycleDialog').getAttribute('aria-labelledby'),
    ).toBe('lifecycleDialogTitle');
    expect(
      page.element('lifecycleDialog').getAttribute('aria-describedby'),
    ).toBe('lifecycleDialogDescription');
    expect(html).not.toMatch(
      /id="(?:lifecyclePassword|withdrawConfirmation)"[^>]*value="[^"]+"/,
    );
  });

  it.each([{}, { ok: false, reauthenticate: true }, { ok: true }])(
    'does not claim unlink for an incomplete success response %j',
    async (result) => {
      const page = loadPage(overview(false), '/profile', connectedLifecycle());
      await settle();
      await lifecycleAction(page).dispatch('click');
      page.queue(response(result));
      await page.element('lifecycleForm').dispatch('submit');
      expect(page.assign).not.toHaveBeenCalled();
      expect(page.element('lifecycleNoticeInDialog').dataset.tone).toBe(
        'error',
      );
      expect(page.element('confirmLifecycleButton').disabled).toBe(false);
    },
  );

  it.each([{}, { ok: true }, { withdrawn: false }, { reauthenticate: true }])(
    'does not claim withdrawal for an incomplete success response %j',
    async (result) => {
      const page = loadPage(overview(false));
      await settle();
      await page.element('withdrawButton').dispatch('click');
      await input(page, 'withdrawConfirmation', 'DELETE');
      page.queue(response(result));
      await page.element('lifecycleForm').dispatch('submit');
      expect(page.assign).not.toHaveBeenCalled();
      expect(page.element('lifecycleNoticeInDialog').dataset.tone).toBe(
        'error',
      );
      expect(page.element('lifecycleNoticeInDialog').textContent).not.toContain(
        '완료되었습니다',
      );
      expect(page.element('confirmLifecycleButton').disabled).toBe(false);
    },
  );

  it.each([{}, { reauthenticate: true }, { redirectUrl: null }])(
    'does not claim completion or navigate on malformed reconnect response %j',
    async (result) => {
      const page = loadPage(
        overview(false),
        '/profile',
        connectedLifecycle({ requiresProviderAuthentication: true }),
      );
      await settle();
      page.queue(response(result));
      await lifecycleAction(page, 'reconnect').dispatch('click');
      expect(page.assign).not.toHaveBeenCalled();
      expect(page.element('lifecycleNotice').dataset.tone).toBe('error');
      expect(page.element('lifecycleNotice').textContent).not.toContain('완료');
      expect(lifecycleAction(page, 'reconnect').disabled).toBe(false);
    },
  );

  it('displays a server-confirmed current policy date without checking boxes or backfilling consent', async () => {
    const page = loadPage();
    await settle();
    expect(page.element('policySection').hidden).toBe(false);
    expect(page.element('policyForm').hidden).toBe(true);
    expect(page.element('policyStatus').textContent).toContain('2026');
    expect(page.element('policyStatus').textContent).toContain('KST');
    expect(page.element('termsPolicyAccepted').checked).toBe(false);
    expect(page.element('privacyPolicyAccepted').checked).toBe(false);
    expect(page.element('termsPolicyLink').getAttribute('href')).toBe(
      'https://auth.example.com/terms',
    );
    expect(page.element('privacyPolicyLink').getAttribute('href')).toBe(
      'https://auth.example.com/privacy',
    );
    expect(
      page.calls.filter((call) => call.options.method === 'POST'),
    ).toHaveLength(0);
    const root = loadPage(overview(), '/');
    await settle();
    expect(root.element('policySection').hidden).toBe(true);
    expect(root.calls.map((call) => call.url)).toEqual(['/api/portal/me']);
  });

  it('requires two unchecked explicit agreements and submits only the fetched snapshot with CSRF, not passwords', async () => {
    const policies = {
      ...policiesOverview(false),
      termsVersion: 'fresh-terms',
      privacyVersion: 'fresh-privacy',
      policyDigest: 'b'.repeat(64),
      acceptedAt: '2025-01-01T00:00:00Z',
    };
    const page = loadPage(
      overview(),
      '/profile',
      lifecycleOverview(),
      policies,
    );
    await settle();
    expect(page.element('policyForm').hidden).toBe(false);
    expect(page.element('policyStatus').textContent).not.toContain('2025');
    expect(page.element('termsPolicyAccepted').checked).toBe(false);
    expect(page.element('privacyPolicyAccepted').checked).toBe(false);
    await page.element('policyForm').dispatch('submit');
    page.element('termsPolicyAccepted').checked = true;
    await page.element('termsPolicyAccepted').dispatch('change');
    await page.element('policyForm').dispatch('submit');
    expect(page.calls).toHaveLength(3);
    page.element('currentPassword').value = 'must-not-send';
    await agreePolicies(page);
    page.queue(
      response({
        ...policies,
        accepted: true,
        acceptedAt: '2026-11-18T01:00:00Z',
      }),
    );
    await page.element('policyForm').dispatch('submit');
    expectPost(page, 3, '/api/portal/policies', {
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: 'fresh-terms',
      privacyVersion: 'fresh-privacy',
      policyDigest: 'b'.repeat(64),
    });
    expect(JSON.parse(page.calls[3].options.body!)).not.toHaveProperty(
      'currentPassword',
    );
    expect(page.element('policyForm').hidden).toBe(true);
    expect(page.element('policyNotice').dataset.tone).toBe('success');
    expect(page.element('termsPolicyAccepted').checked).toBe(false);
    expect(page.assign).not.toHaveBeenCalled();
  });

  it('resets stale 400 consent and requires a new status snapshot before retry', async () => {
    const page = loadPage(
      overview(),
      '/profile',
      lifecycleOverview(),
      policiesOverview(false),
    );
    await settle();
    await agreePolicies(page);
    page.queue(
      response(
        {
          code: 'policy_acceptance_required',
          message: '현재 정책을 다시 확인해 주세요.',
        },
        400,
      ),
    );
    await page.element('policyForm').dispatch('submit');
    expect(page.element('termsPolicyAccepted').checked).toBe(false);
    expect(page.element('privacyPolicyAccepted').checked).toBe(false);
    expect(page.element('savePolicyButton').disabled).toBe(true);
    expect(page.element('reloadPolicyButton').hidden).toBe(false);
    expect(page.element('policyNotice').dataset.tone).toBe('error');
    const latest = {
      ...policiesOverview(false),
      termsVersion: 'latest-terms',
      policyDigest: 'c'.repeat(64),
    };
    page.queuePolicies(response(latest));
    await page.element('reloadPolicyButton').dispatch('click');
    expect(page.element('termsPolicyAccepted').checked).toBe(false);
    expect(page.element('privacyPolicyAccepted').checked).toBe(false);
    await page.element('policyForm').dispatch('submit');
    expect(page.calls).toHaveLength(5);
    await agreePolicies(page);
    page.queue(
      response({
        ...latest,
        accepted: true,
        acceptedAt: '2026-11-18T02:00:00Z',
      }),
    );
    await page.element('policyForm').dispatch('submit');
    expectPost(page, 5, '/api/portal/policies', {
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: latest.termsVersion,
      privacyVersion: latest.privacyVersion,
      policyDigest: latest.policyDigest,
    });
  });

  it('keeps policy requests single-flight and blocks concurrent profile commands while saving', async () => {
    const pending = deferred<UiResponse>();
    const page = loadPage(
      overview(),
      '/profile',
      lifecycleOverview(),
      pending.promise,
    );
    await settle();
    expect(page.element('policySection').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(page.element('savePolicyButton').disabled).toBe(true);
    expect(page.element('termsPolicyAccepted').disabled).toBe(true);
    pending.resolve(response(policiesOverview(false)));
    await settle();
    await agreePolicies(page);
    const saving = deferred<UiResponse>();
    page.queue(saving.promise);
    const submit = page.element('policyForm').dispatch('submit');
    expect(page.element('policyForm').getAttribute('aria-busy')).toBe('true');
    expect(page.element('savePolicyButton').disabled).toBe(true);
    expect(page.element('termsPolicyAccepted').disabled).toBe(true);
    await page.element('policyForm').dispatch('submit');
    await page.element('logoutButton').dispatch('click');
    await page.element('withdrawButton').dispatch('click');
    expect(page.calls).toHaveLength(4);
    expect(page.element('lifecycleDialog').open).toBe(false);
    saving.resolve(response(policiesOverview()));
    await submit;
    expect(page.element('policyNotice').dataset.tone).toBe('success');
  });

  it('does not gate existing profile credentials on current policy acceptance', async () => {
    const page = loadPage(
      overview(),
      '/profile',
      lifecycleOverview(),
      policiesOverview(false),
    );
    await settle();
    await passwords(page);
    expect(page.element('savePasswordButton').disabled).toBe(false);
    expect(page.element('editEmailButton').disabled).toBe(false);
    expect(page.element('withdrawButton').disabled).toBe(false);
  });

  it.each(['GET', 'POST'])(
    'redirects an expired policy %s session to login',
    async (method) => {
      const page = loadPage(
        overview(),
        '/profile',
        lifecycleOverview(),
        method === 'GET'
          ? Promise.resolve(response({}, 401))
          : policiesOverview(false),
      );
      await settle();
      if (method === 'POST') {
        await agreePolicies(page);
        page.queue(response({}, 401));
        await page.element('policyForm').dispatch('submit');
      }
      expect(page.assign).toHaveBeenCalledWith('/login');
      expect(page.element('policyNotice').dataset.tone).toBe('error');
      expect(page.element('savePolicyButton').disabled).toBe(true);
    },
  );

  it.each([
    { ...policiesOverview(false), termsUrl: 'javascript:alert(1)' },
    {
      ...policiesOverview(false),
      privacyUrl: 'https://attacker.example/privacy',
    },
    { ...policiesOverview(), acceptedAt: null },
    { ...policiesOverview(false), policyDigest: 'invalid' },
  ])('fails closed on invalid current policy metadata %j', async (policies) => {
    const page = loadPage(
      overview(),
      '/profile',
      lifecycleOverview(),
      Promise.resolve(response(policies)),
    );
    await settle();
    expect(page.element('policyNotice').dataset.tone).toBe('error');
    expect(page.element('policyForm').hidden).toBe(true);
    expect(page.element('savePolicyButton').disabled).toBe(true);
    expect(page.element('reloadPolicyButton').hidden).toBe(false);
    expect(
      page.calls.filter((call) => call.options.method === 'POST'),
    ).toHaveLength(0);
  });

  it('preserves profile functions after policy GET failure and supports reload', async () => {
    const page = loadPage(
      overview(),
      '/profile',
      lifecycleOverview(),
      Promise.resolve(response({ message: 'Unavailable' }, 503)),
    );
    await settle();
    expect(page.element('portalContent').hidden).toBe(false);
    expect(page.element('editEmailButton').disabled).toBe(false);
    page.queuePolicies(response(policiesOverview(false)));
    await page.element('reloadPolicyButton').dispatch('click');
    expect(page.element('policyForm').hidden).toBe(false);
    expect(page.element('termsPolicyAccepted').checked).toBe(false);
  });

  it('does not claim acceptance on an incomplete POST response', async () => {
    const page = loadPage(
      overview(),
      '/profile',
      lifecycleOverview(),
      policiesOverview(false),
    );
    await settle();
    await agreePolicies(page);
    page.queue(response({ accepted: true }));
    await page.element('policyForm').dispatch('submit');
    expect(page.element('policyNotice').dataset.tone).toBe('error');
    expect(page.element('termsPolicyAccepted').checked).toBe(false);
    expect(page.element('privacyPolicyAccepted').checked).toBe(false);
    expect(page.element('reloadPolicyButton').hidden).toBe(false);
  });
});
