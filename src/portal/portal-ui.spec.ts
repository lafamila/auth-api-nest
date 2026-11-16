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

function loadPage(
  me: ReturnType<typeof overview> | Promise<UiResponse> = overview(),
  path = '/profile',
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
  const calls: FetchCall[] = [];
  const assign = jest.fn();
  const fetch = (url: string, options: FetchCall['options']) => {
    calls.push({ url, options });
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
    reject: (error: Error) => {
      pending.push(Promise.reject(error));
    },
  };
}

type Page = ReturnType<typeof loadPage>;

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

async function input(page: Page, id: string, value: string) {
  page.element(id).value = value;
  await page.element(id).dispatch('input');
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

describe('portal UI', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
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
    expectPost(page, 1, '/api/portal/password', {
      password: 'new-password!',
      passwordConfirm: 'new-password!',
      currentPassword: 'old-password!',
    });
    expect(JSON.parse(page.calls[1].options.body ?? '{}')).not.toHaveProperty(
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
    expect(page.calls).toHaveLength(1);
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
    expectPost(page, 1, '/api/signup/check-login-id', { loginId: 'new-id' });
    await passwords(page);
    expect(page.element('savePasswordButton').disabled).toBe(false);
    page.queue(response({ reauthenticate: true }));
    await page.element('passwordForm').dispatch('submit');
    expectPost(page, 2, '/api/portal/password', {
      password: 'new-password!',
      passwordConfirm: 'new-password!',
      loginId: 'new-id',
    });
    expect(JSON.parse(page.calls[2].options.body ?? '{}')).not.toHaveProperty(
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
    expectPost(page, 1, '/api/portal/email/start', {
      currentPassword: 'current!',
      email: 'new@example.com',
    });
    expect(page.element('emailCurrentPassword').value).toBe('');
    expect(page.element('emailStartForm').hidden).toBe(true);
    expect(page.element('emailCompleteForm').hidden).toBe(false);
    await input(page, 'emailCode', 'A1B2C3');
    page.queue(response({ reauthenticate: true }));
    await page.element('emailCompleteForm').dispatch('submit');
    expectPost(page, 2, '/api/portal/email/complete', {
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
    expect(page.calls).toHaveLength(1);
    page.element('newEmail').checkValidity.mockReturnValue(true);
    await input(page, 'newEmail', 'new@example.com');
    const pending = deferred<UiResponse>();
    page.queue(pending.promise);
    const sending = page.element('emailStartForm').dispatch('submit');
    expect(page.element('sendEmailButton').disabled).toBe(true);
    expect(page.element('closeEmailButton').disabled).toBe(true);
    await page.element('emailStartForm').dispatch('submit');
    await page.element('closeEmailButton').dispatch('click');
    expect(page.calls).toHaveLength(2);
    expect(page.element('emailDialog').open).toBe(true);
    pending.resolve(response({ verificationId: 'verification-uuid' }));
    await sending;
    await input(page, 'emailCode', '123');
    await page.element('emailCompleteForm').dispatch('submit');
    expect(page.calls).toHaveLength(2);
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
    expect(page.calls).toHaveLength(1);
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
    expect(page.calls).toHaveLength(2);
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
    expect(page.calls).toHaveLength(2);
  });

  it('posts logout with CSRF and redirects to login', async () => {
    const page = loadPage();
    await settle();
    page.queue(response({}));
    await page.element('logoutButton').dispatch('click');
    expectPost(page, 1, '/api/portal/logout', {});
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
    expectPost(page, 2, '/api/portal/password', {
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
    expectPost(page, 2, '/api/portal/email/start', {
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
    expectPost(page, 3, '/api/portal/email/complete', {
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
    expectPost(page, 1, '/api/portal/social/google/link', {});
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
});
