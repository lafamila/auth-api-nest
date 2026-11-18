import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderOtpPage } from '../portal/portal-pages';
import { PublicPage, PublicSiteService } from './public-site.service';

const ROOT = join(__dirname, '..', '..');
const PAGES: PublicPage[] = ['about', 'privacy', 'terms', 'contact'];

function setup(settings: Record<string, unknown> = {}) {
  const get = jest.fn((key: string) => settings[key]);
  const service = new PublicSiteService({ get } as unknown as ConfigService);
  return { service, get };
}

describe('PublicSiteService', () => {
  it('returns fixed policy versions and confirmed operator facts', () => {
    const { service, get } = setup();
    expect(service.policyVersions()).toEqual({
      termsVersion: '2026-11-18',
      privacyVersion: '2026-11-18',
    });
    expect(service.publicMetadata()).toEqual({
      operatorName: '이경민',
      supportEmail: 'lafamila325@gmail.com',
      privacyContactName: '이경민',
      hostingCountry: '대한민국',
      hostingProvider: '운영자 개인 NAS 직접 호스팅',
      mailProvider: 'Google Gmail SMTP',
      mailProcessingRegions: null,
      retention: {
        authDataRetentionHours: 1,
        auditRetentionDays: 30,
        backupRetentionDays: 7,
      },
      readiness: {
        operatorFactsConfirmed: true,
        mailProcessingRegionsConfirmed: false,
        unconfirmedDetails: [
          'AUTH_PUBLIC_MAIL_PROCESSING_REGIONS',
          'mailProviderRetention',
        ],
      },
    });
    expect(get.mock.calls.map(([key]) => key).sort()).toEqual(
      [
        'AUTH_PUBLIC_OPERATOR_NAME',
        'AUTH_PUBLIC_SUPPORT_EMAIL',
        'AUTH_PUBLIC_PRIVACY_CONTACT_NAME',
        'AUTH_PUBLIC_HOSTING_COUNTRY',
        'AUTH_PUBLIC_HOSTING_PROVIDER',
        'AUTH_PUBLIC_MAIL_PROVIDER',
        'AUTH_PUBLIC_MAIL_PROCESSING_REGIONS',
        'AUTH_PRIVACY_AUTH_DATA_RETENTION_HOURS',
        'AUTH_PRIVACY_AUDIT_RETENTION_DAYS',
        'AUTH_PUBLIC_BACKUP_RETENTION_DAYS',
      ].sort(),
    );
  });

  it('reads only public settings and has deterministic, independently returned metadata', () => {
    const { service, get } = setup({
      AUTH_PUBLIC_OPERATOR_NAME: ' 운영자 ',
      AUTH_PUBLIC_SUPPORT_EMAIL: ' public@example.com ',
      AUTH_PUBLIC_PRIVACY_CONTACT_NAME: ' 담당자 ',
      AUTH_PUBLIC_HOSTING_COUNTRY: ' 대한민국 ',
      AUTH_PUBLIC_HOSTING_PROVIDER: ' 개인 NAS ',
      AUTH_PUBLIC_MAIL_PROVIDER: ' Gmail SMTP ',
      AUTH_PUBLIC_MAIL_PROCESSING_REGIONS: ' 운영자가 확인한 공개 지역 설명 ',
      SMTP_PASSWORD: 'private-smtp-password',
      DATABASE_URL: 'private-database-url',
    });
    const metadata = service.publicMetadata();
    expect(metadata).toMatchObject({
      operatorName: '운영자',
      supportEmail: 'public@example.com',
      privacyContactName: '담당자',
      hostingCountry: '대한민국',
      hostingProvider: '개인 NAS',
      mailProvider: 'Gmail SMTP',
      mailProcessingRegions: '운영자가 확인한 공개 지역 설명',
      readiness: { mailProcessingRegionsConfirmed: true },
    });
    expect(metadata.readiness.unconfirmedDetails).not.toContain(
      'AUTH_PUBLIC_MAIL_PROCESSING_REGIONS',
    );
    const serialized = JSON.stringify(metadata);
    expect(JSON.stringify(service.publicMetadata())).toBe(serialized);
    metadata.readiness.unconfirmedDetails.push('external mutation');
    expect(JSON.stringify(service.publicMetadata())).toBe(serialized);
    expect(get).not.toHaveBeenCalledWith('SMTP_PASSWORD');
    expect(get).not.toHaveBeenCalledWith('DATABASE_URL');
    expect(serialized).not.toContain('private-');
  });

  it('uses confirmed defaults for blank or non-string settings', () => {
    const { service } = setup({
      AUTH_PUBLIC_OPERATOR_NAME: '   ',
      AUTH_PUBLIC_SUPPORT_EMAIL: null,
      AUTH_PUBLIC_PRIVACY_CONTACT_NAME: 17,
      AUTH_PUBLIC_HOSTING_COUNTRY: undefined,
      AUTH_PUBLIC_MAIL_PROCESSING_REGIONS: '\n ',
    });
    expect(service.publicMetadata()).toMatchObject({
      operatorName: '이경민',
      supportEmail: 'lafamila325@gmail.com',
      privacyContactName: '이경민',
      hostingCountry: '대한민국',
      mailProcessingRegions: null,
    });
  });

  it.each(PAGES)(
    'renders a complete Korean %s page without scripts',
    (page) => {
      const { service } = setup();
      const html = service.render(page);
      expect(html).toContain('<html lang="ko">');
      expect(html).toContain('Teddy Auth');
      expect(html).toContain('data-auth-public-page');
      expect(html).toContain('id="public-content"');
      expect(html).toContain(`href="/${page}" aria-current="page"`);
      expect(html).toContain('src="/brand/auth-logo-128.png"');
      expect(html).toContain('href="/brand/favicon-32.png"');
      expect(html).toContain('href="/brand/apple-touch-icon.png"');
      expect(html).toContain('content="/brand/auth-logo-1024.png"');
      expect(html).toContain('href="/public/assets/site.css"');
      expect(html).toContain('<footer class="auth-site-footer"');
      for (const publicPage of PAGES)
        expect(html).toContain(`href="/${publicPage}"`);
      expect(html).not.toMatch(/<script\b|\bon(?:click|load|error)\s*=/i);
      expect(html).not.toMatch(/<iframe\b|https:\/\/fonts\.|gstatic\.com/i);
    },
  );

  it.each(PAGES)(
    'escapes every public setting in %s, including mailto links',
    (page) => {
      const payload = `<img src=x onerror="alert('x')"> & </title><script>bad()</script>`;
      const { service } = setup({
        AUTH_PUBLIC_OPERATOR_NAME: payload,
        AUTH_PUBLIC_SUPPORT_EMAIL: payload,
        AUTH_PUBLIC_PRIVACY_CONTACT_NAME: payload,
        AUTH_PUBLIC_HOSTING_COUNTRY: payload,
        AUTH_PUBLIC_HOSTING_PROVIDER: payload,
        AUTH_PUBLIC_MAIL_PROVIDER: payload,
        AUTH_PUBLIC_MAIL_PROCESSING_REGIONS: payload,
      });
      const html = service.render(page);
      expect(html).not.toContain(payload);
      expect(html).not.toContain('<script>bad()');
      expect(html).toContain(
        '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;',
      );
      expect(html).toContain('&amp; &lt;/title&gt;');
      expect(html).toContain('href="mailto:%3Cimg%20src%3Dx%20onerror%3D%22');
      expect(html).not.toContain('href="mailto:<');
    },
  );

  it('does not turn a hostile email value into a URL scheme or HTML attribute', () => {
    const { service } = setup({
      AUTH_PUBLIC_SUPPORT_EMAIL:
        'javascript:alert(1)" onclick="bad()\r\nbcc:other@example.com',
    });
    const html = service.render('contact');
    expect(html).toContain(
      'href="mailto:javascript%3Aalert(1)%22%20onclick%3D%22',
    );
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('" onclick="bad()');
    expect(html).toContain('%0D%0Abcc%3Aother%40example.com');
  });

  it('discloses actual scope, optional notifications, retries and privacy request rights', () => {
    const { service } = setup();
    const privacy = service.render('privacy');
    for (const text of [
      'User-Agent',
      '비밀번호 해시',
      '제공자별 계정 식별자',
      '서비스별 권한',
      '서비스별·기기별 수신 동의',
      'Google Gmail SMTP',
      '대한민국',
      '개인 NAS 직접 호스팅',
      '구체적인 처리 국가·지역은 확인되지 않았습니다.',
      '국외 처리가 발생할 수 있습니다.',
      '다른 서비스의 게시물, 파일, 게임 기록',
      '최대 24시간 보관',
      '성공하거나 재시도가 종료되면 암호문을 삭제',
      '화면에서 직접 수정할 수 없는 항목도 문의를 통한 정정 요청',
      '마지막 활성 최고 관리자',
      '과거 가입자의 확인 이력을 임의로 만들지 않습니다.',
    ])
      expect(privacy).toContain(text);
    expect(privacy).not.toContain('미국');
    expect(privacy).not.toContain('법률 검토가 완료');
    expect(privacy).not.toContain('모든 개인정보는 즉시');
  });

  it('describes last-method protection without blanket Kakao restrictions', () => {
    const { service } = setup();
    const terms = service.render('terms');
    expect(terms).toContain(
      '마지막 로그인 수단의 단순 연결 해제는 허용되지 않습니다.',
    );
    expect(terms).toContain('마지막 활성 최고 관리자');
    expect(terms).toContain(
      '다른 서비스의 콘텐츠는 Auth 탈퇴만으로 삭제되지 않고',
    );
    expect(terms).toContain(
      '제공자의 검수·승인이나 모든 서비스에서의 이용 가능성을 보장하지 않습니다.',
    );
    expect(terms).not.toMatch(/카카오.{0,20}(차단|금지)/);
  });

  it.each(['privacy', 'terms'] as const)(
    'renders the %s policy version',
    (page) => {
      expect(setup().service.render(page)).toContain(
        '<time datetime="2026-11-18">2026-11-18</time>',
      );
    },
  );

  it('adds form branding without changing fields, action, scripts or hidden provider forms', () => {
    const { service } = setup();
    const script = 'const template = "literal $& $` $\'";';
    const originalBody = `<form action="/oauth/login?return_to=%2Fprofile" method="post"><input name="login_transaction" value="&quot;transaction&quot;" /><input name="password" type="password" required /><button type="submit" form="social">선택</button></form><form class="social-provider-form" id="social" method="post" action="/oauth/login/social/google"><input type="hidden" name="login_transaction" value="same-transaction" /></form><script src="/oauth/hosted-login.js" defer></script><script>${script}</script>`;
    const original = `<!doctype html><html lang="ko"><head><style>form{width:340px}</style></head><body class="original" data-existing="kept">${originalBody}</body></html>`;
    const decorated = service.decorate(original, 'form');
    expect(decorated).toContain(originalBody);
    expect(decorated).toContain(`<script>${script}</script>`);
    expect(decorated).toContain('<style>form{width:340px}</style>');
    expect(decorated).toContain(
      '<body class="original" data-existing="kept" data-auth-site-layout="form">',
    );
    expect(decorated).toContain('<header class="auth-site-form-header">');
    expect((decorated.match(/<script\b/g) ?? []).length).toBe(2);
    expect(service.decorate(decorated, 'form')).toBe(decorated);
  });

  it.each([
    { file: 'signup.html', layout: 'form' as const },
    { file: 'portal.html', layout: 'application' as const },
    { file: 'index.html', layout: 'application' as const },
    { file: 'bootstrap.html', layout: 'application' as const },
  ])(
    'preserves the complete existing $file body and script bytes',
    ({ file, layout }) => {
      const original = readFileSync(join(ROOT, 'public', file), 'utf8');
      const body = original.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i)![1];
      const scripts = [
        ...original.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi),
      ].map(([script]) => script);
      const decorated = setup().service.decorate(original, layout);
      expect(decorated).toContain(body);
      expect(
        [...decorated.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map(
          ([script]) => script,
        ),
      ).toEqual(scripts);
      if (layout === 'application')
        expect(decorated).not.toContain('class="auth-site-form-header"');
      expect(setup().service.decorate(decorated, layout)).toBe(decorated);
    },
  );

  it('preserves the existing OTP transaction, autofocusing field and external script', () => {
    const original = renderOtpPage('transaction<&', '사용자');
    const decorated = setup().service.decorate(original, 'form');
    expect(decorated).toContain('action="/login/otp"');
    expect(decorated).toContain('value="transaction&lt;&amp;"');
    expect(decorated).toContain('required autofocus');
    expect(decorated).toContain(
      '<script src="/oauth/hosted-login.js" defer></script>',
    );
    expect(decorated).toContain('auth-site-form-header');
  });

  it('supports uppercase document tags and does not decorate non-documents', () => {
    const { service } = setup();
    expect(
      service.decorate('<HTML><HEAD></HEAD><BODY>kept</BODY></HTML>'),
    ).toContain('data-auth-site-layout="application"');
    for (const fragment of [
      'plain text',
      '<p>fragment</p>',
      '<head></head><p>no body</p>',
      '<body>no head</body>',
    ])
      expect(service.decorate(fragment)).toBe(fragment);
  });

  it('keeps stylesheet rules scoped and gives policy checkboxes independent fixed dimensions', () => {
    const stylesheet = readFileSync(
      join(ROOT, 'public', 'public-site.css'),
      'utf8',
    );
    expect(stylesheet).toContain(
      "[data-auth-site-layout] .policy-acceptance input[type='checkbox']",
    );
    const checkbox = stylesheet.match(
      /\.policy-acceptance input\[type='checkbox'\] \{([^}]*)\}/,
    )![1];
    expect(checkbox).toContain('width: 16px;');
    expect(checkbox).toContain('min-height: 16px;');
    expect(checkbox).toContain('margin: 0;');
    expect(stylesheet).not.toMatch(
      /(?:^|\n)(?:body|main|form|a|input|button|:root|\*)\s*\{/,
    );
    expect(stylesheet).not.toMatch(
      /@import|https?:\/\/|font-size:\s*\d+(?:\.\d+)?vw|letter-spacing:\s*-/,
    );
  });
});
