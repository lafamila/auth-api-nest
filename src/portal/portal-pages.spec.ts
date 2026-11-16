import { createHash } from 'node:crypto';
import { privatePageHeaders, renderOtpPage } from './portal-pages';

describe('Portal page security', () => {
  it('permits same-origin stylesheet and hashed console scripts without inline JavaScript permission', () => {
    const script = 'console.log("portal")';
    const headers = privatePageHeaders(`<script>${script}</script>`);
    expect(headers['Content-Security-Policy']).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
    expect(headers['Content-Security-Policy']).toContain(
      `'sha256-${createHash('sha256').update(script).digest('base64')}'`,
    );
    expect(headers['Content-Security-Policy']).not.toMatch(
      /script-src[^;]*'unsafe-inline'/,
    );
    expect(headers['Content-Security-Policy']).toContain("form-action 'self'");
    expect(headers['Content-Security-Policy']).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers['Cache-Control']).toBe('no-store');
  });

  it('escapes OTP names, errors and transaction attributes', () => {
    const page = renderOtpPage(
      '" onfocus="alert(1)',
      '<script>name</script>',
      '<img src=x onerror=alert(1)>',
    );
    expect(page).not.toContain('<script>name</script>');
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;script&gt;name&lt;/script&gt;');
    expect(page).toContain('value="&quot; onfocus=&quot;alert(1)"');
    expect(page).toContain('action="/login/otp"');
    expect(page).toContain('data-single-submit');
  });
});
