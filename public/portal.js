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
    return state.loading || state.busy || state.navigating || state.reauth;
  }

  function localCredentials() {
    return state.me && state.me.account.hasLocalCredentials === true;
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
            path === '/api/portal/email/start')) ||
          (payload?.code === 'invalid_email_verification' &&
            path === '/api/portal/email/complete'));
      if (response.status === 401 && !fieldValidationError) {
        state.navigating = true;
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
    if (error.reauthenticate) {
      state.reauth = true;
      message('pageNotice', '다시 인증한 후 계속해 주세요.', 'error');
      $('recoveryActions').hidden = false;
      $('retryButton').hidden = true;
      $('reauthButton').hidden = false;
      $('emailReauthButton').hidden = !$('emailDialog').open;
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

  async function loadMe() {
    if (state.loading) return;
    state.loading = true;
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

  function mutationComplete(result, target) {
    if (result.reauthenticate === true) {
      state.navigating = true;
      for (const id of [
        'currentPassword',
        'newPassword',
        'passwordConfirm',
        'emailCurrentPassword',
        'emailCode',
      ])
        $(id).value = '';
      state.passwordValid = state.confirmValid = false;
      state.verificationId = '';
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

  async function linkProvider(key, button) {
    if (locked() || state.checking) return;
    button.setAttribute('aria-busy', 'true');
    await mutate(
      `/api/portal/social/${encodeURIComponent(key)}/link`,
      {},
      'pageNotice',
      (result) => {
        if (typeof result.redirectUrl !== 'string' || !result.redirectUrl)
          throw new Error('연결 주소를 확인할 수 없습니다.');
        const url = new URL(result.redirectUrl, window.location.origin);
        if (
          url.origin !== window.location.origin ||
          !['https:', 'http:'].includes(url.protocol)
        )
          throw new Error('연결 주소를 확인할 수 없습니다.');
        state.navigating = true;
        message('pageNotice', '소셜 계정 인증으로 이동합니다.');
        window.location.assign(url.href);
      },
    );
    button.setAttribute('aria-busy', 'false');
  }

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
    if (!localCredentials() || locked()) return;
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
