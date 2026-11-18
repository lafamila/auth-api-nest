(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const profileRoute =
    window.location.pathname.replace(/\/$/, '') === '/profile';
  const providerKeys = new Set(['google', 'kakao', 'naver']);
  const state = {
    me: null,
    loading: false,
    busy: false,
    checking: false,
    navigating: false,
    reauth: false,
    checkedId: '',
    idRevision: 0,
    passwordValid: false,
    confirmValid: false,
    verificationId: '',
    lifecycle: null,
    lifecycleLoading: false,
    lifecycleCommand: null,
    lifecycleFocus: null,
    policies: null,
    policiesLoading: false,
    policiesSaving: false,
  };
  let passwordTimer;
  let confirmTimer;

  function message(id, value = '', tone = '') {
    const element = $(id);
    element.textContent = value;
    element.dataset.tone = tone;
    if (id === 'pageNotice') element.hidden = !value;
  }

  function locked() {
    return (
      state.loading ||
      state.lifecycleLoading ||
      state.policiesLoading ||
      state.busy ||
      state.navigating ||
      state.reauth
    );
  }

  function localCredentials() {
    return state.me && state.me.account.hasLocalCredentials === true;
  }

  function providerEnabled(provider) {
    return Boolean(
      state.me?.socialProviders.some(
        (item) => item.key === provider && item.enabled === true,
      ),
    );
  }

  function requiresLifecyclePassword() {
    return typeof state.lifecycle?.actor?.requiresCurrentPassword === 'boolean'
      ? state.lifecycle.actor.requiresCurrentPassword
      : Boolean(localCredentials());
  }

  function lifecycleReady() {
    const command = state.lifecycleCommand;
    if (!state.me || !state.lifecycle || !command || locked() || state.checking)
      return false;
    if (requiresLifecyclePassword() && !$('lifecyclePassword').value)
      return false;
    if (command.kind === 'withdraw')
      return (
        state.lifecycle.accountDeletion.allowed &&
        $('withdrawConfirmation').value === 'DELETE'
      );
    const connection = state.lifecycle.connections.find(
      (item) => item.provider === command.provider,
    );
    return Boolean(
      connection?.canUnlink && !connection.requiresProviderAuthentication,
    );
  }

  function passwordReady() {
    return Boolean(
      state.me &&
      !locked() &&
      !state.checking &&
      state.passwordValid &&
      state.confirmValid &&
      $('newPassword').value.length >= 8 &&
      /[^A-Za-z0-9]/.test($('newPassword').value) &&
      $('newPassword').value === $('passwordConfirm').value &&
      (localCredentials()
        ? $('currentPassword').value !== ''
        : state.checkedId && state.checkedId === $('newLoginId').value.trim()),
    );
  }

  function renderControls() {
    const disabled = !state.me || locked() || state.checking;
    const local = localCredentials();
    for (const id of ['currentPassword', 'newPassword', 'passwordConfirm']) {
      $(id).disabled = disabled || (id === 'currentPassword' && !local);
    }
    $('newLoginId').disabled = !state.me || locked() || local;
    $('checkLoginIdButton').disabled =
      disabled ||
      local ||
      state.checking ||
      !$('newLoginId').value.trim() ||
      state.checkedId === $('newLoginId').value.trim();
    $('checkLoginIdButton').textContent = state.checking
      ? '확인 중'
      : '중복 확인';
    $('checkLoginIdButton').setAttribute('aria-busy', String(state.checking));
    $('savePasswordButton').disabled = !passwordReady();
    $('passwordForm').setAttribute('aria-busy', String(state.busy));
    $('editEmailButton').disabled = disabled || !local;
    $('logoutButton').disabled = disabled;
    for (const button of $('providerList').querySelectorAll('button')) {
      button.disabled = disabled;
    }
    for (const id of ['emailCurrentPassword', 'newEmail', 'emailCode']) {
      $(id).disabled = disabled || !local;
    }
    $('sendEmailButton').disabled =
      disabled ||
      !local ||
      !$('emailCurrentPassword').value ||
      !$('newEmail').value.trim() ||
      !$('newEmail').checkValidity() ||
      $('newEmail').value.trim() === (state.me && state.me.account.email);
    $('completeEmailButton').disabled =
      disabled ||
      !local ||
      !state.verificationId ||
      !/^[A-Za-z0-9]{6}$/.test($('emailCode').value.trim());
    $('closeEmailButton').disabled = state.busy || state.navigating;
    $('restartEmailButton').disabled = disabled;
    $('emailDialog').setAttribute('aria-busy', String(state.busy));
    $('retryButton').disabled = state.loading;
    $('lifecycleSection').setAttribute(
      'aria-busy',
      String(state.lifecycleLoading),
    );
    $('retryLifecycleButton').disabled = disabled;
    $('withdrawButton').disabled =
      disabled || !state.lifecycle?.accountDeletion.allowed;
    for (const button of $('connectionList').querySelectorAll('button')) {
      const connection = state.lifecycle?.connections.find(
        (item) => item.provider === button.dataset.provider,
      );
      button.disabled =
        disabled ||
        !connection ||
        (button.dataset.action === 'reconnect'
          ? !connection.requiresProviderAuthentication ||
            !providerEnabled(connection.provider)
          : !connection.canUnlink || connection.requiresProviderAuthentication);
    }
    $('lifecyclePassword').disabled =
      disabled || !state.lifecycleCommand || !requiresLifecyclePassword();
    $('withdrawConfirmation').disabled =
      disabled || state.lifecycleCommand?.kind !== 'withdraw';
    $('confirmLifecycleButton').disabled = !lifecycleReady();
    $('confirmLifecycleButton').setAttribute(
      'aria-busy',
      String(state.busy && Boolean(state.lifecycleCommand)),
    );
    $('closeLifecycleButton').disabled = $('cancelLifecycleButton').disabled =
      state.busy || state.navigating;
    $('lifecycleDialog').setAttribute(
      'aria-busy',
      String(state.busy && Boolean(state.lifecycleCommand)),
    );
    const policyDisabled =
      disabled || !state.policies || state.policies.accepted;
    for (const id of ['termsPolicyAccepted', 'privacyPolicyAccepted'])
      $(id).disabled = policyDisabled;
    $('savePolicyButton').disabled =
      policyDisabled ||
      !$('termsPolicyAccepted').checked ||
      !$('privacyPolicyAccepted').checked;
    $('savePolicyButton').textContent = state.policiesSaving
      ? '저장 중'
      : '동의 저장';
    $('savePolicyButton').setAttribute(
      'aria-busy',
      String(state.policiesSaving),
    );
    $('policyForm').setAttribute('aria-busy', String(state.policiesSaving));
    $('policySection').setAttribute(
      'aria-busy',
      String(state.policiesLoading || state.policiesSaving),
    );
    $('reloadPolicyButton').disabled = disabled;
  }

  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        if (state.me) headers['X-CSRF-Token'] = state.me.csrfToken;
      }
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      let payload;
      try {
        const raw = await response.text();
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        payload = null;
      }
      const fieldValidationError =
        body !== undefined &&
        ((payload?.code === 'invalid_current_password' &&
          (path === '/api/portal/password' ||
            path === '/api/portal/email/start' ||
            path === '/api/portal/withdraw' ||
            /^\/api\/portal\/social\/(google|kakao|naver)\/unlink$/.test(
              path,
            ))) ||
          (payload?.code === 'invalid_email_verification' &&
            path === '/api/portal/email/complete'));
      if (response.status === 401 && !fieldValidationError) {
        state.navigating = true;
        clearSecrets();
        window.location.assign('/login');
        throw new Error('로그인이 필요합니다.');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('응답을 확인할 수 없습니다. 다시 시도해 주세요.');
      }
      if (!response.ok) {
        const error = new Error(
          typeof payload.message === 'string'
            ? payload.message
            : Array.isArray(payload.message) &&
                payload.message.every((item) => typeof item === 'string')
              ? payload.message.join(' ')
              : '요청을 처리하지 못했습니다. 다시 시도해 주세요.',
        );
        error.reauthenticate =
          response.status === 403 &&
          payload.code === 'reauthentication_required';
        error.code = payload.code;
        throw error;
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error('응답 시간이 초과되었습니다. 다시 시도해 주세요.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function reportError(error, target) {
    if (target === 'lifecycleNotice' || target === 'lifecycleNoticeInDialog') {
      const reasons = {
        last_login_method:
          '아이디 / 비밀번호나 다른 로그인 수단을 먼저 추가해 주세요.',
        last_superadmin:
          '마지막 최고 관리자는 탈퇴할 수 없습니다. 다른 최고 관리자를 먼저 지정해 주세요.',
        last_active_superadmin:
          '마지막 최고 관리자는 탈퇴할 수 없습니다. 다른 최고 관리자를 먼저 지정해 주세요.',
        provider_reauthentication_required:
          '소셜 계정으로 다시 인증한 후 계속해 주세요.',
        provider_revocation_unavailable:
          '제공자 연결 철회를 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.',
      };
      if (Object.prototype.hasOwnProperty.call(reasons, error.code))
        error.message = reasons[error.code];
    }
    if (error.reauthenticate) {
      state.reauth = true;
      clearSecrets();
      message('pageNotice', '다시 인증한 후 계속해 주세요.', 'error');
      $('recoveryActions').hidden = false;
      $('retryButton').hidden = true;
      $('reauthButton').hidden = false;
      $('emailReauthButton').hidden = !$('emailDialog').open;
      $('lifecycleReauthButton').hidden = !$('lifecycleDialog').open;
    }
    message(
      target,
      error.reauthenticate
        ? '다시 인증한 후 계속해 주세요.'
        : error.message || '요청을 처리하지 못했습니다.',
      'error',
    );
  }

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined && value !== null)
      element.textContent = String(value);
    return element;
  }

  function icon(name) {
    const image = node('img', 'icon');
    image.src = `/portal/assets/icons/${name}.svg`;
    image.alt = '';
    image.width = image.height = 16;
    return image;
  }

  function dateLabel(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? ''
      : new Intl.DateTimeFormat('ko-KR', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(date);
  }

  function renderServices(services) {
    $('serviceList').replaceChildren();
    $('serviceCount').textContent = `${services.length}개`;
    $('servicesEmpty').hidden = services.length !== 0;
    for (const service of services) {
      const row = node('article', 'service-row');
      const initial = node(
        'span',
        'service-initial',
        (service.name || service.key || '').slice(0, 1),
      );
      initial.setAttribute('aria-hidden', 'true');
      const details = node('div', 'service-details');
      details.append(node('h2', '', service.name || service.key));
      if (service.description)
        details.append(node('p', 'service-description', service.description));
      const granted = dateLabel(service.grantedAt);
      if (granted) details.append(node('p', 'service-date', `${granted} 등록`));
      const role = node(
        'span',
        'permission-label',
        service.permission.label || service.permission.key,
      );
      row.append(initial, details, role);
      $('serviceList').append(row);
    }
  }

  function renderProviders(providers) {
    $('providerList').replaceChildren();
    let visible = 0;
    for (const provider of providers) {
      if (!providerKeys.has(provider.key)) continue;
      if (!provider.linked && !provider.enabled) continue;
      visible += 1;
      const row = node('div', 'provider-row');
      const image = icon('key-round');
      image.className = 'provider-symbol';
      const details = node('div', 'provider-details');
      details.append(node('h3', '', provider.label));
      const linkedAt = provider.linked ? dateLabel(provider.linkedAt) : '';
      if (linkedAt) details.append(node('p', 'muted', `${linkedAt} 연결`));
      row.append(image, details);
      if (provider.linked) {
        const status = node('span', 'linked-status');
        status.append(icon('check'), node('span', '', '연결됨'));
        row.append(status);
      } else if (provider.enabled) {
        const button = node('button', 'secondary-button');
        button.type = 'button';
        button.setAttribute('aria-label', `${provider.label} 계정 연결`);
        button.append(icon('link'), node('span', '', '연결'));
        button.addEventListener('click', () =>
          linkProvider(provider.key, button),
        );
        row.append(button);
      }
      $('providerList').append(row);
    }
    $('providersEmpty').hidden = visible > 0;
  }

  function renderAccount() {
    const { account, services, socialProviders } = state.me;
    $('accountIdentifier').textContent =
      account.loginId || account.email || account.id;
    $('servicesNavLabel').textContent = account.isSuperAdmin
      ? '관리 콘솔'
      : '내 서비스';
    (profileRoute ? $('profileNav') : $('servicesNav')).setAttribute(
      'aria-current',
      'page',
    );
    document.title = `${profileRoute ? '내 정보' : '내 서비스'} | Teddy Auth`;
    $('profileName').value = account.name || '';
    $('profileLoginId').value = account.loginId || '미등록';
    $('profileEmail').value = account.email || '';
    $('editEmailButton').hidden = !localCredentials();
    $('newLoginIdField').hidden = localCredentials();
    $('currentPasswordField').hidden = !localCredentials();
    $('currentPassword').required = localCredentials();
    $('newLoginId').required = !localCredentials();
    $('passwordTitle').textContent = localCredentials()
      ? '비밀번호 변경'
      : '아이디 / 비밀번호 등록';
    $('savePasswordButton').textContent = localCredentials()
      ? '비밀번호 변경'
      : '아이디 / 비밀번호 등록';
    renderServices(services);
    renderProviders(socialProviders);
    $('servicesView').hidden = profileRoute;
    $('profileView').hidden = !profileRoute;
    $('portalHeader').hidden =
      $('portalNav').hidden =
      $('portalContent').hidden =
        false;
  }

  function renderLifecycle() {
    $('connectionList').replaceChildren();
    const labels = { google: 'Google', kakao: 'Kakao', naver: 'Naver' };
    for (const connection of state.lifecycle.connections) {
      const {
        provider,
        identityCount,
        canUnlink,
        requiresProviderAuthentication,
      } = connection;
      const label = labels[provider];
      const row = node('div', 'lifecycle-row');
      const details = node('div', 'lifecycle-details');
      details.append(
        node(
          'h3',
          '',
          `${label}${identityCount > 1 ? ` (${identityCount}개 연결)` : ''}`,
        ),
      );
      const reason =
        connection.reason === 'last_login_method'
          ? '아이디 / 비밀번호나 다른 로그인 수단을 먼저 추가해 주세요.'
          : requiresProviderAuthentication
            ? providerEnabled(provider)
              ? `${label}로 다시 인증한 후 연결을 해제해 주세요.`
              : `${label} 인증을 현재 사용할 수 없습니다.`
            : connection.reason === 'provider_revocation_unavailable'
              ? '제공자 연결 철회를 처리할 수 없습니다. 잠시 후 다시 불러와 주세요.'
              : !canUnlink
                ? '아이디 / 비밀번호나 다른 로그인 수단을 먼저 추가해 주세요.'
                : '해제하면 이 소셜 계정으로 로그인할 수 없습니다.';
      details.append(node('p', 'muted', reason));
      const actions = node('div', 'lifecycle-actions');
      if (requiresProviderAuthentication && providerEnabled(provider)) {
        const reconnect = node('button', 'secondary-button', '다시 인증');
        reconnect.type = 'button';
        reconnect.dataset.provider = provider;
        reconnect.dataset.action = 'reconnect';
        reconnect.setAttribute('aria-label', `${label}로 다시 인증`);
        reconnect.addEventListener('click', () =>
          reconnectProvider(provider, reconnect),
        );
        actions.append(reconnect);
      }
      const unlink = node('button', 'quiet-button danger-command', '연결 해제');
      unlink.type = 'button';
      unlink.dataset.provider = provider;
      unlink.dataset.action = 'unlink';
      unlink.setAttribute('aria-label', `${label} 연결 해제`);
      unlink.addEventListener('click', () =>
        openLifecycle(
          { kind: 'unlink', provider, label, identityCount },
          unlink,
        ),
      );
      actions.append(unlink);
      row.append(details, actions);
      $('connectionList').append(row);
    }
    $('connectionsEmpty').hidden = state.lifecycle.connections.length !== 0;
    const deletion = state.lifecycle.accountDeletion;
    $('withdrawBlockedReason').hidden = deletion.allowed;
    $('withdrawBlockedReason').textContent = deletion.allowed
      ? ''
      : ['last_superadmin', 'last_active_superadmin'].includes(
            deletion.blockedReason,
          )
        ? '마지막 최고 관리자는 탈퇴할 수 없습니다. 다른 최고 관리자를 먼저 지정해 주세요.'
        : deletion.blockedReason === 'provider_reauthentication_required'
          ? '소셜 계정으로 다시 인증한 후 탈퇴를 진행해 주세요.'
          : deletion.blockedReason === 'provider_revocation_unavailable'
            ? '제공자 연결 철회를 처리할 수 없습니다. 잠시 후 다시 불러와 주세요.'
            : '현재 계정은 탈퇴할 수 없습니다. 관리자에게 문의해 주세요.';
  }

  async function loadLifecycle() {
    if (
      !profileRoute ||
      !state.me ||
      state.lifecycleLoading ||
      state.navigating ||
      state.reauth
    )
      return;
    state.lifecycle = null;
    state.lifecycleLoading = true;
    $('lifecycleSection').hidden = false;
    $('connectionList').replaceChildren();
    $('connectionsEmpty').hidden = true;
    $('retryLifecycleButton').hidden = true;
    $('withdrawBlockedReason').hidden = true;
    message('lifecycleNotice', '연결 및 탈퇴 정보를 불러오는 중입니다.');
    renderControls();
    try {
      const lifecycle = await request('/api/portal/lifecycle');
      if (
        typeof lifecycle.accountDeletion?.allowed !== 'boolean' ||
        lifecycle.accountDeletion.serviceDataPolicy !== 'separate' ||
        !Array.isArray(lifecycle.connections) ||
        lifecycle.connections.some(
          (connection) =>
            !connection ||
            !providerKeys.has(connection.provider) ||
            !Number.isInteger(connection.identityCount) ||
            connection.identityCount < 1 ||
            typeof connection.canUnlink !== 'boolean' ||
            typeof connection.requiresProviderAuthentication !== 'boolean',
        )
      )
        throw new Error(
          '연결 및 탈퇴 정보를 확인할 수 없습니다. 다시 불러와 주세요.',
        );
      state.lifecycle = lifecycle;
      renderLifecycle();
      message('lifecycleNotice');
    } catch (error) {
      reportError(error, 'lifecycleNotice');
      $('retryLifecycleButton').hidden = state.navigating || state.reauth;
    } finally {
      state.lifecycleLoading = false;
      renderControls();
    }
  }

  async function loadMe() {
    if (state.loading) return;
    state.loading = true;
    state.lifecycle = null;
    $('lifecycleSection').hidden = true;
    state.policies = null;
    $('policySection').hidden = true;
    $('loadingState').hidden = false;
    $('portalContent').hidden = true;
    $('recoveryActions').hidden = true;
    message('pageNotice');
    renderControls();
    try {
      const me = await request('/api/portal/me');
      if (
        !me ||
        !me.account ||
        !Array.isArray(me.services) ||
        !Array.isArray(me.socialProviders) ||
        typeof me.csrfToken !== 'string' ||
        !me.csrfToken
      ) {
        throw new Error('계정 정보를 확인할 수 없습니다. 다시 시도해 주세요.');
      }
      state.me = me;
      renderAccount();
      if (profileRoute) await loadLifecycle();
      if (profileRoute) await loadPolicies();
    } catch (error) {
      reportError(error, 'pageNotice');
      if (!state.navigating) {
        $('recoveryActions').hidden = false;
        $('retryButton').hidden = state.reauth;
      }
    } finally {
      state.loading = false;
      $('loadingState').hidden = true;
      renderControls();
    }
  }

  function policyStatus(payload) {
    if (
      typeof payload.accepted !== 'boolean' ||
      typeof payload.termsVersion !== 'string' ||
      !payload.termsVersion ||
      typeof payload.privacyVersion !== 'string' ||
      !payload.privacyVersion ||
      typeof payload.policyDigest !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(payload.policyDigest) ||
      (payload.accepted &&
        (typeof payload.acceptedAt !== 'string' ||
          Number.isNaN(new Date(payload.acceptedAt).getTime())))
    )
      throw new Error(
        '정책 동의 상태를 확인할 수 없습니다. 다시 불러와 주세요.',
      );
    const urls = {};
    for (const key of ['termsUrl', 'privacyUrl']) {
      if (typeof payload[key] !== 'string' || !payload[key])
        throw new Error('정책 주소를 확인할 수 없습니다.');
      const url = new URL(payload[key], window.location.origin);
      if (
        url.origin !== window.location.origin ||
        !['https:', 'http:'].includes(url.protocol)
      )
        throw new Error('정책 주소를 확인할 수 없습니다.');
      urls[key] = url.href;
    }
    return { ...payload, ...urls };
  }

  function renderPolicies() {
    const policies = state.policies;
    $('termsPolicyAccepted').checked = $('privacyPolicyAccepted').checked =
      false;
    $('termsPolicyLink').setAttribute('href', policies.termsUrl);
    $('privacyPolicyLink').setAttribute('href', policies.privacyUrl);
    $('policyForm').hidden = policies.accepted;
    const acceptedAt = policies.accepted
      ? new Intl.DateTimeFormat('ko-KR', {
          timeZone: 'Asia/Seoul',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(policies.acceptedAt))
      : '';
    message(
      'policyStatus',
      policies.accepted
        ? `현재 정책 동의 완료 · ${acceptedAt} (KST)`
        : '현재 이용약관과 개인정보처리방침에 대한 동의가 필요합니다.',
      policies.accepted ? 'success' : '',
    );
  }

  async function loadPolicies() {
    if (
      !profileRoute ||
      !state.me ||
      state.policiesLoading ||
      state.navigating ||
      state.reauth
    )
      return;
    state.policies = null;
    state.policiesLoading = true;
    $('policySection').hidden = false;
    $('policyForm').hidden = true;
    $('termsPolicyAccepted').checked = $('privacyPolicyAccepted').checked =
      false;
    $('reloadPolicyButton').hidden = true;
    message('policyStatus', '정책 동의 상태를 불러오는 중입니다.');
    message('policyNotice');
    renderControls();
    try {
      state.policies = policyStatus(await request('/api/portal/policies'));
      renderPolicies();
    } catch (error) {
      message('policyStatus');
      reportError(error, 'policyNotice');
      $('reloadPolicyButton').hidden = state.navigating || state.reauth;
    } finally {
      state.policiesLoading = false;
      renderControls();
    }
  }

  $('reloadPolicyButton').addEventListener('click', () => {
    if (
      !locked() &&
      !state.checking &&
      !$('emailDialog').open &&
      !$('lifecycleDialog').open
    )
      return loadPolicies();
  });
  for (const id of ['termsPolicyAccepted', 'privacyPolicyAccepted'])
    $(id).addEventListener('change', renderControls);
  $('policyForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (
      !state.me ||
      locked() ||
      state.checking ||
      !state.policies ||
      state.policies.accepted ||
      !$('termsPolicyAccepted').checked ||
      !$('privacyPolicyAccepted').checked ||
      $('emailDialog').open ||
      $('lifecycleDialog').open
    )
      return;
    const snapshot = state.policies;
    state.busy = state.policiesSaving = true;
    message('policyNotice', '동의를 저장하는 중입니다.');
    renderControls();
    try {
      const result = policyStatus(
        await request('/api/portal/policies', {
          termsAccepted: true,
          privacyAccepted: true,
          termsVersion: snapshot.termsVersion,
          privacyVersion: snapshot.privacyVersion,
          policyDigest: snapshot.policyDigest,
        }),
      );
      if (
        !result.accepted ||
        result.termsVersion !== snapshot.termsVersion ||
        result.privacyVersion !== snapshot.privacyVersion ||
        result.policyDigest !== snapshot.policyDigest
      )
        throw new Error(
          '동의 결과를 확인할 수 없습니다. 현재 정책을 다시 불러와 주세요.',
        );
      state.policies = result;
      renderPolicies();
      message('policyNotice', '동의가 저장되었습니다.', 'success');
      $('reloadPolicyButton').hidden = true;
    } catch (error) {
      state.policies = null;
      $('termsPolicyAccepted').checked = $('privacyPolicyAccepted').checked =
        false;
      message('policyStatus', '현재 정책을 다시 불러온 후 동의해 주세요.');
      reportError(error, 'policyNotice');
      $('reloadPolicyButton').hidden = state.navigating || state.reauth;
    } finally {
      state.busy = state.policiesSaving = false;
      renderControls();
    }
  });

  function clearSecrets() {
    clearTimeout(passwordTimer);
    clearTimeout(confirmTimer);
    for (const id of [
      'currentPassword',
      'newPassword',
      'passwordConfirm',
      'emailCurrentPassword',
      'emailCode',
      'lifecyclePassword',
      'withdrawConfirmation',
    ])
      $(id).value = '';
    state.passwordValid = state.confirmValid = false;
    state.verificationId = '';
  }

  function mutationComplete(result, target) {
    if (result.reauthenticate === true) {
      state.navigating = true;
      clearSecrets();
      message(target, '완료되었습니다. 로그인 화면으로 이동합니다.', 'success');
      setTimeout(() => window.location.assign('/login'), 900);
      return true;
    }
    message(target, '완료되었습니다.', 'success');
    return false;
  }

  async function mutate(path, body, target, onSuccess) {
    if (!state.me || locked() || state.checking) return;
    state.busy = true;
    message(target, '처리 중입니다.');
    renderControls();
    try {
      const result = await request(path, body);
      if (!mutationComplete(result, target) && onSuccess)
        await onSuccess(result);
    } catch (error) {
      reportError(error, target);
    } finally {
      state.busy = false;
      renderControls();
    }
  }

  function navigateProvider(result, target) {
    if (typeof result.redirectUrl !== 'string' || !result.redirectUrl)
      throw new Error('연결 주소를 확인할 수 없습니다.');
    const url = new URL(result.redirectUrl, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      !['https:', 'http:'].includes(url.protocol)
    )
      throw new Error('연결 주소를 확인할 수 없습니다.');
    state.navigating = true;
    clearSecrets();
    message(target, '소셜 계정 인증으로 이동합니다.');
    window.location.assign(url.href);
  }

  async function linkProvider(key, button) {
    if (locked() || state.checking) return;
    button.setAttribute('aria-busy', 'true');
    await mutate(
      `/api/portal/social/${encodeURIComponent(key)}/link`,
      {},
      'pageNotice',
      (result) => navigateProvider(result, 'pageNotice'),
    );
    button.setAttribute('aria-busy', 'false');
  }

  async function reconnectProvider(provider, button) {
    if (
      locked() ||
      state.checking ||
      !providerEnabled(provider) ||
      !state.lifecycle?.connections.some(
        (item) =>
          item.provider === provider && item.requiresProviderAuthentication,
      )
    )
      return;
    state.busy = true;
    button.setAttribute('aria-busy', 'true');
    message('lifecycleNotice', '소셜 계정 인증을 준비하는 중입니다.');
    renderControls();
    try {
      const result = await request(
        `/api/portal/social/${encodeURIComponent(provider)}/reconnect`,
        {},
      );
      navigateProvider(result, 'lifecycleNotice');
    } catch (error) {
      reportError(error, 'lifecycleNotice');
    } finally {
      state.busy = false;
      button.setAttribute('aria-busy', 'false');
      renderControls();
    }
  }

  function openLifecycle(command, button) {
    if (
      !state.lifecycle ||
      locked() ||
      state.checking ||
      $('emailDialog').open ||
      $('lifecycleDialog').open
    )
      return;
    if (command.kind === 'withdraw' && !state.lifecycle.accountDeletion.allowed)
      return;
    if (
      command.kind === 'unlink' &&
      !state.lifecycle.connections.some(
        (item) =>
          item.provider === command.provider &&
          item.canUnlink &&
          !item.requiresProviderAuthentication,
      )
    )
      return;
    state.lifecycleCommand = command;
    state.lifecycleFocus = button;
    $('lifecyclePassword').value = $('withdrawConfirmation').value = '';
    $('lifecyclePassword').removeAttribute('aria-invalid');
    const withdraw = command.kind === 'withdraw';
    $('lifecyclePasswordField').hidden = !requiresLifecyclePassword();
    $('lifecyclePassword').required = requiresLifecyclePassword();
    $('withdrawConfirmationField').hidden = !withdraw;
    $('withdrawConfirmation').required = withdraw;
    $('lifecycleDialogTitle').textContent = withdraw
      ? 'Auth 계정 탈퇴'
      : `${command.label} 연결 해제`;
    $('lifecycleDialogDescription').textContent = withdraw
      ? 'Auth 계정과 인증 데이터가 삭제되며 복구할 수 없습니다. Todo, BodyLab, Chat 등 다른 서비스 데이터는 삭제되지 않으므로 각 서비스에서 별도로 삭제해야 합니다. 제공자 연결 철회는 대기열에서 처리될 수 있습니다.'
      : `${command.label} 연결${command.identityCount > 1 ? ` ${command.identityCount}개를 모두` : '을'} 해제하면 이 소셜 계정으로 로그인할 수 없습니다. 제공자 연결 철회는 대기열에서 처리될 수 있습니다.`;
    $('confirmLifecycleButton').textContent = withdraw
      ? 'Auth 계정 탈퇴'
      : '연결 해제';
    $('lifecycleReauthButton').hidden = true;
    message('lifecycleNoticeInDialog');
    $('lifecycleDialog').showModal();
    renderControls();
    (withdraw
      ? $('withdrawConfirmation')
      : requiresLifecyclePassword()
        ? $('lifecyclePassword')
        : $('cancelLifecycleButton')
    ).focus();
  }

  function closeLifecycle() {
    if (state.busy || state.navigating) return;
    $('lifecycleDialog').close();
    $('lifecyclePassword').value = $('withdrawConfirmation').value = '';
    state.lifecycleCommand = null;
    message('lifecycleNoticeInDialog');
    renderControls();
    if (state.reauth) $('reauthButton').focus();
    else state.lifecycleFocus?.focus();
    state.lifecycleFocus = null;
  }

  $('withdrawButton').addEventListener('click', () =>
    openLifecycle({ kind: 'withdraw' }, $('withdrawButton')),
  );
  $('closeLifecycleButton').addEventListener('click', closeLifecycle);
  $('cancelLifecycleButton').addEventListener('click', closeLifecycle);
  $('lifecycleDialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeLifecycle();
  });
  for (const id of ['lifecyclePassword', 'withdrawConfirmation'])
    $(id).addEventListener('input', renderControls);
  $('retryLifecycleButton').addEventListener('click', () => {
    if (!locked() && !state.checking) return loadLifecycle();
  });
  $('lifecycleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!lifecycleReady()) return;
    const command = state.lifecycleCommand;
    const withdraw = command.kind === 'withdraw';
    const body = { confirmation: withdraw ? 'DELETE' : 'UNLINK' };
    if (requiresLifecyclePassword())
      body.currentPassword = $('lifecyclePassword').value;
    state.busy = true;
    message('lifecycleNoticeInDialog', '처리 중입니다.');
    renderControls();
    try {
      const result = await request(
        withdraw
          ? '/api/portal/withdraw'
          : `/api/portal/social/${encodeURIComponent(command.provider)}/unlink`,
        body,
      );
      if (
        withdraw
          ? result.withdrawn !== true
          : result.ok !== true || result.reauthenticate !== true
      )
        throw new Error(
          '처리 결과를 확인할 수 없습니다. 연결 상태를 다시 확인해 주세요.',
        );
      state.navigating = true;
      clearSecrets();
      state.me = state.lifecycle = null;
      for (const id of [
        'profileName',
        'profileEmail',
        'profileLoginId',
        'newLoginId',
        'newEmail',
      ])
        $(id).value = '';
      $('accountIdentifier').textContent = '';
      $('serviceList').replaceChildren();
      $('providerList').replaceChildren();
      $('connectionList').replaceChildren();
      $('portalContent').hidden =
        $('portalHeader').hidden =
        $('portalNav').hidden =
          true;
      $('emailDialog').close();
      const pending = Array.isArray(result.pendingProviderRevocations)
        ? result.pendingProviderRevocations.length > 0
        : Boolean(result.pendingProviderRevocations);
      message(
        'lifecycleNoticeInDialog',
        `${withdraw ? 'Auth 계정 탈퇴가' : '연결 해제가'} 완료되었습니다.${pending ? ' 제공자 연결 철회는 대기열에서 처리될 수 있습니다.' : ''}`,
        'success',
      );
      setTimeout(
        () => window.location.assign(withdraw ? '/about' : '/login'),
        900,
      );
    } catch (error) {
      reportError(error, 'lifecycleNoticeInDialog');
    } finally {
      state.busy = false;
      renderControls();
    }
  });

  function validatePassword() {
    state.passwordValid =
      $('newPassword').value.length >= 8 &&
      /[^A-Za-z0-9]/.test($('newPassword').value);
    $('newPassword').setAttribute('aria-invalid', String(!state.passwordValid));
    message(
      'passwordFeedback',
      state.passwordValid
        ? '사용 가능한 비밀번호입니다.'
        : '8자 이상, 특수문자 1개 이상을 입력해 주세요.',
      state.passwordValid ? 'success' : 'error',
    );
    renderControls();
  }

  function validateConfirm() {
    state.confirmValid =
      state.passwordValid &&
      $('passwordConfirm').value !== '' &&
      $('passwordConfirm').value === $('newPassword').value;
    $('passwordConfirm').setAttribute(
      'aria-invalid',
      String(Boolean($('passwordConfirm').value) && !state.confirmValid),
    );
    message(
      'passwordConfirmFeedback',
      !$('passwordConfirm').value
        ? ''
        : state.confirmValid
          ? '비밀번호가 일치합니다.'
          : '비밀번호가 일치하지 않습니다.',
      state.confirmValid ? 'success' : 'error',
    );
    renderControls();
  }

  $('newPassword').addEventListener('input', () => {
    state.passwordValid = state.confirmValid = false;
    clearTimeout(passwordTimer);
    clearTimeout(confirmTimer);
    message('passwordFeedback');
    message('passwordConfirmFeedback');
    message('passwordNotice');
    $('newPassword').removeAttribute('aria-invalid');
    $('passwordConfirm').removeAttribute('aria-invalid');
    passwordTimer = setTimeout(validatePassword, 1000);
    confirmTimer = setTimeout(validateConfirm, 1000);
    renderControls();
  });

  $('passwordConfirm').addEventListener('input', () => {
    state.confirmValid = false;
    clearTimeout(confirmTimer);
    message('passwordConfirmFeedback');
    message('passwordNotice');
    $('passwordConfirm').removeAttribute('aria-invalid');
    confirmTimer = setTimeout(validateConfirm, 1000);
    renderControls();
  });

  $('currentPassword').addEventListener('input', renderControls);
  $('newLoginId').addEventListener('input', () => {
    state.idRevision += 1;
    state.checkedId = '';
    message('loginIdFeedback');
    message('passwordNotice');
    renderControls();
  });

  $('checkLoginIdButton').addEventListener('click', async () => {
    const loginId = $('newLoginId').value.trim();
    if (
      !state.me ||
      localCredentials() ||
      locked() ||
      state.checking ||
      !loginId
    )
      return;
    const revision = state.idRevision;
    state.checking = true;
    message('loginIdFeedback', '확인 중입니다.');
    renderControls();
    try {
      const result = await request('/api/signup/check-login-id', { loginId });
      if (revision !== state.idRevision) return;
      state.checkedId = result.available === true ? loginId : '';
      message(
        'loginIdFeedback',
        state.checkedId
          ? '사용 가능한 아이디입니다.'
          : '이미 사용 중인 아이디입니다.',
        state.checkedId ? 'success' : 'error',
      );
    } catch (error) {
      if (revision === state.idRevision) reportError(error, 'loginIdFeedback');
    } finally {
      state.checking = false;
      renderControls();
    }
  });

  $('passwordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!passwordReady()) return;
    const body = {
      password: $('newPassword').value,
      passwordConfirm: $('passwordConfirm').value,
    };
    if (localCredentials()) body.currentPassword = $('currentPassword').value;
    else body.loginId = $('newLoginId').value.trim();
    await mutate('/api/portal/password', body, 'passwordNotice', async () => {
      $('currentPassword').value =
        $('newPassword').value =
        $('passwordConfirm').value =
          '';
      state.passwordValid = state.confirmValid = false;
      message('passwordFeedback');
      message('passwordConfirmFeedback');
      await loadMe();
    });
  });

  function resetEmail() {
    state.verificationId = '';
    $('emailCurrentPassword').value =
      $('newEmail').value =
      $('emailCode').value =
        '';
    $('emailStartForm').hidden = false;
    $('emailCompleteForm').hidden = true;
    $('emailReauthButton').hidden = true;
    message('emailNotice');
    renderControls();
  }

  $('editEmailButton').addEventListener('click', () => {
    if (!localCredentials() || locked() || $('lifecycleDialog').open) return;
    resetEmail();
    $('emailDialog').showModal();
    $('emailCurrentPassword').focus();
  });

  function closeEmail() {
    if (state.busy || state.navigating) return;
    $('emailDialog').close();
    resetEmail();
    $('editEmailButton').focus();
  }

  $('closeEmailButton').addEventListener('click', closeEmail);
  $('emailDialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeEmail();
  });
  $('emailDialog').addEventListener('click', (event) => {
    if (event.target === $('emailDialog')) {
      const bounds = $('emailDialog').getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        closeEmail();
    }
  });
  $('restartEmailButton').addEventListener('click', () => {
    if (locked()) return;
    resetEmail();
    $('emailCurrentPassword').focus();
  });
  for (const id of ['emailCurrentPassword', 'newEmail', 'emailCode'])
    $(id).addEventListener('input', renderControls);

  $('emailStartForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('sendEmailButton').disabled || !localCredentials()) return;
    const email = $('newEmail').value.trim();
    await mutate(
      '/api/portal/email/start',
      { currentPassword: $('emailCurrentPassword').value, email },
      'emailNotice',
      (result) => {
        if (typeof result.verificationId !== 'string' || !result.verificationId)
          throw new Error(
            '인증 요청을 확인할 수 없습니다. 다시 시도해 주세요.',
          );
        state.verificationId = result.verificationId;
        $('emailCurrentPassword').value = '';
        $('emailSentTo').textContent = `${email}로 인증번호를 보냈습니다.`;
        $('emailStartForm').hidden = true;
        $('emailCompleteForm').hidden = false;
        message('emailNotice');
      },
    );
    if (state.verificationId && !locked()) $('emailCode').focus();
  });

  $('emailCompleteForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('completeEmailButton').disabled || !localCredentials()) return;
    await mutate(
      '/api/portal/email/complete',
      {
        verificationId: state.verificationId,
        code: $('emailCode').value.trim(),
      },
      'emailNotice',
      async () => {
        state.verificationId = '';
        $('emailDialog').close();
        resetEmail();
        await loadMe();
        message('pageNotice', '이메일 변경이 완료되었습니다.', 'success');
      },
    );
  });

  $('logoutButton').addEventListener('click', () =>
    mutate('/api/portal/logout', {}, 'pageNotice', () => {
      state.navigating = true;
      window.location.assign('/login');
    }),
  );
  $('retryButton').addEventListener('click', loadMe);
  void loadMe();
})();
