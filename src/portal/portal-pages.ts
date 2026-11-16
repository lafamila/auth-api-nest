import { createHash } from 'node:crypto';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ]!,
  );

export function privatePageHeaders(html = ''): Record<string, string> {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter((match) => match[1].trim())
    .map(
      (match) =>
        `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`,
    );
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'self' ${scripts.join(' ')}; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`,
  };
}

export function renderOtpPage(transaction: string, name: string, error = '') {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Google OTP | Teddy Auth</title>
  <style>:root{color-scheme:light;font-family:Inter,system-ui,sans-serif;letter-spacing:0;color:#151b28;background:#eef1f5}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px}form{width:min(340px,100%);padding:24px;background:#fff;border:1px solid #d9dee7;border-radius:8px;display:grid;gap:12px}h1{font-size:21px;margin:0}p{font-size:13px;margin:0;color:#687386}label{font-size:13px;font-weight:600}input,button{width:100%;min-height:44px;border:1px solid #d9dee7;border-radius:6px;padding:10px;font:inherit}input{font-size:16px}button{background:#1d4ed8;color:#fff;border-color:#1d4ed8;font-size:14px;cursor:pointer}button:disabled{opacity:.65;cursor:wait}a{font-size:13px;color:#1d4ed8;text-decoration:none;text-align:center}.error{color:#b42318;min-height:18px;overflow-wrap:anywhere}</style>
  <script src="/oauth/hosted-login.js" defer></script></head><body>
  <form method="post" action="/login/otp" data-single-submit>
  <h1>Teddy Auth</h1><p>${escapeHtml(name)}</p><input type="hidden" name="transaction" value="${escapeHtml(transaction)}" />
  <label for="otpCode">Google OTP</label><input id="otpCode" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus />
  <button type="submit">확인</button><p class="error" role="alert">${escapeHtml(error)}</p><a href="/login">로그인으로</a></form></body></html>`;
}
