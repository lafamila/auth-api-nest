(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const form = $('socialSignupForm');
  if (!form) return;

  const name = $('name');
  const email = $('email');
  const loginId = $('loginId');
  const password = $('password');
  const confirm = $('passwordConfirm');
  const code = $('code');
  const sendButton = $('sendEmailButton');
  const verifyButton = $('verifyCodeButton');
  const checkButton = $('checkLoginIdButton');
  const continueButton = $('continueButton');
  const state = {
    verifiedEmail:
      form.dataset.emailVerified === 'true' ? email.value.trim() : '',
    sentEmail: '',
    checkedId: '',
    passwordValid: false,
    confirmValid: false,
    checking: false,
    sending: false,
    verifying: false,
    submitting: false,
    idRevision: 0,
    emailRevision: 0,
    codeRevision: 0,
    cooldownUntil: 0,
  };
  let passwordTimer;
  let confirmTimer;
  let cooldownTimer;

  function feedback(id, text = '', tone = '') {
    const element = $(id);
    if (!element) return;
    element.textContent = text;
    element.classList.toggle('error', tone === 'error');
    element.classList.toggle('success', tone === 'success');
  }

  function mark(id, visible) {
    const element = $(id);
    if (element) element.hidden = !visible;
  }

  function invalid(element, value) {
    element.setAttribute('aria-invalid', String(value));
  }

  function emailValid() {
    return email.value.trim() !== '' && email.checkValidity();
  }

  function passwordValid() {
    return password.value.length >= 8 && /[^A-Za-z0-9]/.test(password.value);
  }

  function busy() {
    return (
      state.checking || state.sending || state.verifying || state.submitting
    );
  }

  function ready() {
    const id = loginId.value.trim();
    return (
      !busy() &&
      name.value.trim() !== '' &&
      name.checkValidity() &&
      emailValid() &&
      state.verifiedEmail === email.value.trim() &&
      (!id ||
        (state.checkedId === id &&
          state.passwordValid &&
          state.confirmValid &&
          passwordValid() &&
          password.value === confirm.value))
    );
  }

  function render() {
    const id = loginId.value.trim();
    const verified = emailValid() && state.verifiedEmail === email.value.trim();
    const cooldown = Math.max(
      0,
      Math.ceil((state.cooldownUntil - Date.now()) / 1000),
    );
    email.readOnly =
      form.dataset.emailVerified === 'true' ||
      state.verifying ||
      verified ||
      state.submitting;
    form.setAttribute('aria-busy', String(busy()));
    mark('nameCheck', name.value.trim() !== '' && name.checkValidity());
    mark('emailCheck', verified);
    mark('loginIdCheck', Boolean(id) && state.checkedId === id);
    mark('passwordCheck', Boolean(id) && state.passwordValid);
    mark('passwordConfirmCheck', Boolean(id) && state.confirmValid);
    mark('codeCheck', verified);
    checkButton.disabled = busy() || !id || state.checkedId === id;
    checkButton.textContent = state.checking ? 'Checking...' : 'Check';
    checkButton.setAttribute('aria-busy', String(state.checking));
    if (sendButton) {
      sendButton.hidden = verified;
      sendButton.disabled = busy() || !emailValid() || verified || cooldown > 0;
      sendButton.textContent = state.sending
        ? 'Sending...'
        : cooldown > 0
          ? `Resend (${cooldown}s)`
          : state.sentEmail
            ? 'Resend'
            : 'Send code';
      sendButton.setAttribute('aria-busy', String(state.sending));
    }
    if (code && verifyButton) {
      const sent =
        state.sentEmail === email.value.trim() && state.sentEmail !== '';
      $('codeField').hidden = !sent || verified;
      code.disabled = !sent || state.submitting;
      code.readOnly = verified || state.verifying;
      verifyButton.disabled =
        busy() ||
        !sent ||
        verified ||
        !/^[A-Za-z0-9]{6}$/.test(code.value.trim());
      verifyButton.textContent = state.verifying
        ? 'Verifying...'
        : verified
          ? 'Verified'
          : 'Verify';
      verifyButton.setAttribute('aria-busy', String(state.verifying));
    }
    continueButton.disabled = !ready();
    continueButton.textContent = state.submitting
      ? 'Continuing...'
      : 'Continue';
    continueButton.setAttribute('aria-busy', String(state.submitting));
  }

  async function post(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {
        method: 'POST',
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error('Request failed. Please try again.');
      }
      if (!response.ok) {
        const message = payload && payload.message;
        throw new Error(
          typeof message === 'string'
            ? message
            : Array.isArray(message) &&
                message.every((item) => typeof item === 'string')
              ? message.join(' ')
              : 'Request failed. Please try again.',
        );
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error('Request timed out. Please try again.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function errorMessage(error) {
    return error instanceof Error
      ? error.message
      : 'Request failed. Please try again.';
  }

  function validateConfirm() {
    state.confirmValid =
      state.passwordValid &&
      confirm.value !== '' &&
      confirm.value === password.value;
    invalid(confirm, confirm.value !== '' && !state.confirmValid);
    feedback(
      'passwordConfirmFeedback',
      confirm.value && !state.confirmValid ? 'Passwords do not match.' : '',
      'error',
    );
    render();
  }

  function validatePassword() {
    state.passwordValid = passwordValid();
    invalid(password, !state.passwordValid);
    feedback(
      'passwordFeedback',
      state.passwordValid
        ? ''
        : 'At least 8 characters and 1 special character.',
      'error',
    );
    render();
  }

  name.addEventListener('input', () => {
    invalid(name, name.value.trim() === '');
    feedback(
      'nameFeedback',
      name.value.trim() ? '' : 'Name is required.',
      'error',
    );
    feedback('message');
    render();
  });

  loginId.addEventListener('input', () => {
    state.idRevision += 1;
    state.checkedId = '';
    invalid(loginId, false);
    feedback('loginIdFeedback');
    feedback('message');
    const optionalCredentials = loginId.value.trim() !== '';
    $('passwordFields').hidden = !optionalCredentials;
    password.disabled = confirm.disabled = !optionalCredentials;
    password.required = confirm.required = optionalCredentials;
    if (!optionalCredentials) {
      clearTimeout(passwordTimer);
      clearTimeout(confirmTimer);
      password.value = confirm.value = '';
      state.passwordValid = state.confirmValid = false;
      invalid(password, false);
      invalid(confirm, false);
      feedback('passwordFeedback');
      feedback('passwordConfirmFeedback');
    }
    render();
  });

  checkButton.addEventListener('click', async () => {
    const id = loginId.value.trim();
    if (busy() || !id || state.checkedId === id) return;
    const revision = state.idRevision;
    state.checking = true;
    feedback('loginIdFeedback', 'Checking...');
    feedback('message');
    render();
    try {
      const result = await post('/api/signup/check-login-id', { loginId: id });
      if (revision !== state.idRevision) return;
      state.checkedId = result && result.available === true ? id : '';
      invalid(loginId, !state.checkedId);
      feedback(
        'loginIdFeedback',
        state.checkedId ? 'Available.' : 'ID is already in use.',
        state.checkedId ? 'success' : 'error',
      );
    } catch (error) {
      if (revision === state.idRevision)
        feedback('loginIdFeedback', errorMessage(error), 'error');
    } finally {
      state.checking = false;
      render();
    }
  });

  password.addEventListener('input', () => {
    state.passwordValid = state.confirmValid = false;
    clearTimeout(passwordTimer);
    clearTimeout(confirmTimer);
    feedback('passwordFeedback');
    feedback('passwordConfirmFeedback');
    passwordTimer = setTimeout(validatePassword, 1000);
    confirmTimer = setTimeout(validateConfirm, 1000);
    render();
  });

  confirm.addEventListener('input', () => {
    state.confirmValid = false;
    clearTimeout(confirmTimer);
    feedback('passwordConfirmFeedback');
    confirmTimer = setTimeout(validateConfirm, 1000);
    render();
  });

  email.addEventListener('input', () => {
    state.emailRevision += 1;
    state.codeRevision += 1;
    state.verifiedEmail = state.sentEmail = '';
    if (code) code.value = '';
    invalid(email, !emailValid());
    feedback('emailFeedback');
    feedback('codeFeedback');
    feedback('message');
    render();
  });

  if (sendButton)
    sendButton.addEventListener('click', async () => {
      if (sendButton.disabled || busy() || !emailValid()) return;
      const value = email.value.trim();
      const revision = state.emailRevision;
      state.sending = true;
      state.sentEmail = state.verifiedEmail = '';
      state.codeRevision += 1;
      code.value = '';
      feedback('emailFeedback', 'Sending...');
      feedback('codeFeedback');
      feedback('message');
      render();
      try {
        await post('/oauth/social/email/start', {
          transaction: $('transaction').value,
          email: value,
        });
        // Keep the cooldown even if the address changed while the request was pending.
        state.cooldownUntil = Date.now() + 60000;
        clearInterval(cooldownTimer);
        cooldownTimer = setInterval(() => {
          if (Date.now() >= state.cooldownUntil) clearInterval(cooldownTimer);
          render();
        }, 1000);
        if (revision !== state.emailRevision) return;
        state.sentEmail = value;
        feedback('emailFeedback', 'Code sent.', 'success');
      } catch (error) {
        if (revision === state.emailRevision)
          feedback('emailFeedback', errorMessage(error), 'error');
      } finally {
        state.sending = false;
        render();
      }
    });

  if (code)
    code.addEventListener('input', () => {
      state.codeRevision += 1;
      feedback('codeFeedback');
      render();
    });

  if (verifyButton)
    verifyButton.addEventListener('click', async () => {
      if (verifyButton.disabled || busy()) return;
      const value = email.value.trim();
      const emailRevision = state.emailRevision;
      const codeRevision = state.codeRevision;
      state.verifying = true;
      feedback('codeFeedback', 'Verifying...');
      feedback('message');
      render();
      try {
        await post('/oauth/social/email/verify', {
          transaction: $('transaction').value,
          code: code.value.trim(),
        });
        if (
          emailRevision !== state.emailRevision ||
          codeRevision !== state.codeRevision
        )
          return;
        state.verifiedEmail = value;
        email.readOnly = true;
        feedback('emailFeedback', 'Verified.', 'success');
        feedback('codeFeedback', 'Verified.', 'success');
      } catch (error) {
        if (
          emailRevision === state.emailRevision &&
          codeRevision === state.codeRevision
        )
          feedback('codeFeedback', errorMessage(error), 'error');
      } finally {
        state.verifying = false;
        render();
      }
    });

  form.addEventListener('submit', (event) => {
    if (!ready()) {
      event.preventDefault();
      return;
    }
    name.value = name.value.trim();
    email.value = email.value.trim();
    loginId.value = loginId.value.trim();
    if (!loginId.value) {
      password.value = confirm.value = '';
      password.disabled = confirm.disabled = false;
    }
    state.submitting = true;
    // Read-only controls remain successful controls in the native form POST.
    for (const input of [name, email, loginId, password, confirm])
      input.readOnly = true;
    feedback('message', 'Continuing...');
    render();
  });

  render();
})();
