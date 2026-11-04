export interface SocialSignupPageInput {
  transaction: string;
  email: string;
  emailVerified: boolean;
  name: string;
  error?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function renderDocument(
  title: string,
  content: string,
  signup = false,
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} | Teddy Auth</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #eef1f5;
        --panel: #fff;
        --line: #d9dee7;
        --text: #151b28;
        --muted: #687386;
        --accent: #1d4ed8;
        --accent-soft: #e9efff;
        --danger: #b42318;
        --success: #14804a;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system,
          BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      body {
        margin: 0;
        min-height: 100vh;
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: 20px 16px;
        background: var(--bg);
        color: var(--text);
      }
      main {
        width: 100%;
        max-width: 360px;
        min-width: 0;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        box-shadow: 0 18px 50px rgb(25 33 48 / 10%);
        padding: 22px;
      }
      h1 { margin: 0 0 6px; font-size: 21px; line-height: 1.25; }
      h2 { margin: 0 0 18px; font-size: 16px; font-weight: 600; }
      form, .field, #passwordFields { display: grid; gap: 6px; min-width: 0; }
      form, #passwordFields { gap: 12px; }
      label { font-size: 12px; font-weight: 700; }
      .optional, .hint { color: var(--muted); font-weight: 400; }
      .control-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: start;
        gap: 8px;
      }
      .input-wrap { position: relative; min-width: 0; }
      input, button {
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 6px;
        font: inherit;
      }
      input {
        width: 100%;
        min-width: 0;
        padding: 10px 30px 10px 10px;
        background: var(--panel);
        color: var(--text);
        font-size: 16px;
      }
      input:focus-visible, button:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      input[aria-invalid="true"] { border-color: var(--danger); }
      input:read-only, input:disabled { background: #f3f5f8; }
      button {
        padding: 9px 10px;
        border-color: var(--accent);
        background: var(--accent);
        color: #fff;
        cursor: pointer;
        font-size: 13px;
        font-weight: 700;
      }
      button.secondary { background: var(--panel); color: var(--accent); }
      button:disabled {
        border-color: var(--line);
        background: #f3f5f8;
        color: var(--muted);
        cursor: not-allowed;
      }
      button[aria-busy="true"] { cursor: wait; }
      .check {
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--success);
        font-weight: 700;
        pointer-events: none;
      }
      .feedback, .hint, .message {
        margin: 0;
        font-size: 12px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .feedback:empty, .message:empty { display: none; }
      .error { color: var(--danger); }
      .success { color: var(--success); }
      #continueButton { width: 100%; margin-top: 4px; }
      @media (max-width: 380px) {
        main { padding: 18px; }
        .email-row { grid-template-columns: minmax(0, 1fr); }
      }
    </style>
    ${signup ? '<script src="/oauth/social/signup.js" defer></script>' : ''}
  </head>
  <body>
    <main>${content}</main>
  </body>
</html>`;
}

export function renderSocialSignupPage(input: SocialSignupPageInput): string {
  const emailControls = input.emailVerified
    ? ''
    : `<button id="sendEmailButton" class="secondary" type="button" disabled>Send code</button>`;
  const codeField = input.emailVerified
    ? ''
    : `<div id="codeField" class="field" hidden>
          <label for="code">Verification code</label>
          <div class="control-row">
            <div class="input-wrap">
              <input id="code" autocomplete="one-time-code" maxlength="6" pattern="[A-Za-z0-9]{6}" aria-describedby="codeFeedback" disabled />
              <span id="codeCheck" class="check" aria-hidden="true" hidden>&#10003;</span>
            </div>
            <button id="verifyCodeButton" class="secondary" type="button" disabled>Verify</button>
          </div>
          <p id="codeFeedback" class="feedback" role="status" aria-live="polite"></p>
        </div>`;

  return renderDocument(
    'Complete signup',
    `
      <h1>Teddy Auth</h1>
      <h2>Complete signup</h2>
      <form id="socialSignupForm" method="post" action="/oauth/social/complete" data-email-verified="${input.emailVerified}" aria-busy="false">
        <input id="transaction" type="hidden" name="transaction" value="${escapeHtml(input.transaction)}" />
        <div class="field">
          <label for="name">Name</label>
          <div class="input-wrap">
            <input id="name" name="name" autocomplete="name" value="${escapeHtml(input.name)}" aria-describedby="nameFeedback" required />
            <span id="nameCheck" class="check" aria-hidden="true" hidden>&#10003;</span>
          </div>
          <p id="nameFeedback" class="feedback" role="status" aria-live="polite"></p>
        </div>
        <div class="field">
          <label for="email">Email</label>
          <div class="control-row email-row">
            <div class="input-wrap">
              <input id="email" name="email" type="email" autocomplete="email" value="${escapeHtml(input.email)}" aria-describedby="emailFeedback" required${input.emailVerified ? ' readonly' : ''} />
              <span id="emailCheck" class="check" aria-hidden="true"${input.emailVerified ? '' : ' hidden'}>&#10003;</span>
            </div>
            ${emailControls}
          </div>
          <p id="emailFeedback" class="feedback${input.emailVerified ? ' success' : ''}" role="status" aria-live="polite">${input.emailVerified ? 'Verified.' : ''}</p>
        </div>
        ${codeField}
        <div class="field">
          <label for="loginId">ID <span class="optional">(optional)</span></label>
          <div class="control-row">
            <div class="input-wrap">
              <input id="loginId" name="loginId" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="loginIdFeedback" />
              <span id="loginIdCheck" class="check" aria-hidden="true" hidden>&#10003;</span>
            </div>
            <button id="checkLoginIdButton" class="secondary" type="button" disabled>Check</button>
          </div>
          <p id="loginIdFeedback" class="feedback" role="status" aria-live="polite"></p>
        </div>
        <div id="passwordFields" hidden>
          <div class="field">
            <label for="password">Password</label>
            <div class="input-wrap">
              <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" aria-describedby="passwordRule passwordFeedback" disabled />
              <span id="passwordCheck" class="check" aria-hidden="true" hidden>&#10003;</span>
            </div>
            <p id="passwordRule" class="hint">At least 8 characters and 1 special character.</p>
            <p id="passwordFeedback" class="feedback" role="status" aria-live="polite"></p>
          </div>
          <div class="field">
            <label for="passwordConfirm">Confirm password</label>
            <div class="input-wrap">
              <input id="passwordConfirm" name="passwordConfirm" type="password" autocomplete="new-password" aria-describedby="passwordConfirmFeedback" disabled />
              <span id="passwordConfirmCheck" class="check" aria-hidden="true" hidden>&#10003;</span>
            </div>
            <p id="passwordConfirmFeedback" class="feedback" role="status" aria-live="polite"></p>
          </div>
        </div>
        <button id="continueButton" type="submit" disabled>Continue</button>
        <p id="message" class="message error" role="alert" aria-live="assertive">${escapeHtml(input.error ?? '')}</p>
      </form>`,
    true,
  );
}

export function renderSocialErrorPage(message: string): string {
  return renderDocument(
    'Sign-in unavailable',
    `<h1>Sign-in unavailable</h1><p class="message error" role="alert">${escapeHtml(message)}</p>`,
  );
}
