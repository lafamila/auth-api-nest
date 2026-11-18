(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const form = $('socialSignupForm');
  if (!form) return;

  const name = $('name');
  const email = $('email');
  const code = $('code');
  const sendButton = $('sendEmailButton');
  const verifyButton = $('verifyCodeButton');
  const continueButton = $('continueButton');
  const initialPolicy = {
    termsVersion: $('termsVersion').value,
    privacyVersion: $('privacyVersion').value,
    policyDigest: $('policyDigest').value,
  };
  const state = {
    policy: initialPolicy.termsVersion && initialPolicy.privacyVersion && /^[a-f0-9]{64}$/.test(initialPolicy.policyDigest) ? initialPolicy : null,
    verifiedEmail:
      form.dataset.emailVerified === 'true' ? email.value.trim() : '',
    sentEmail: '',
    sending: false,
    verifying: false,
    submitting: false,
    emailRevision: 0,
    codeRevision: 0,
    cooldownUntil: 0,
  };
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

  function busy() {
    return state.sending || state.verifying || state.submitting;
  }

  function ready() {
    return (
      !busy() &&
      state.policy !== null &&
      $('termsAccepted').checked &&
      $('privacyAccepted').checked &&
      name.value.trim() !== '' &&
      name.checkValidity() &&
      emailValid() &&
      state.verifiedEmail === email.value.trim()
    );
  }

  function render() {
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
    mark('codeCheck', verified);
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
    state.submitting = true;
    // Read-only controls remain successful controls in the native form POST.
    for (const input of [name, email]) input.readOnly = true;
    feedback('message', 'Continuing...');
    render();
  });

  async function loadPolicies() {
    state.policy = null;
    $('termsAccepted').checked = $('privacyAccepted').checked = false;
    $('loadPoliciesButton').hidden = true;
    feedback('policyFeedback', '정책 확인 중...');
    render();
    try {
      const response = await fetch('/api/public/policies', {cache: 'no-store', credentials: 'same-origin'});
      if (!response.ok) throw new Error('정책을 불러오지 못했습니다.');
      const policy = await response.json();
      if (typeof policy.termsVersion !== 'string' || typeof policy.privacyVersion !== 'string' || !/^[a-f0-9]{64}$/.test(policy.policyDigest)) throw new Error('정책 응답을 확인할 수 없습니다.');
      for (const key of ['termsVersion', 'privacyVersion', 'policyDigest']) $(key).value = policy[key];
      state.policy = policy;
      feedback('policyFeedback');
    } catch (error) {
      feedback('policyFeedback', errorMessage(error), 'error');
      $('loadPoliciesButton').hidden = false;
    } finally { render(); }
  }
  $('termsAccepted').addEventListener('change', render);
  $('privacyAccepted').addEventListener('change', render);
  $('loadPoliciesButton').addEventListener('click', () => void loadPolicies());

  render();
  if (!state.policy) void loadPolicies();
})();
