import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { privacyRetentionSettings } from '../policies/privacy-retention.settings';

export type PublicPage = 'about' | 'privacy' | 'terms' | 'contact';
export type PublicSiteLayout = 'form' | 'application';

const POLICY_VERSION = '2026-11-18';
const PAGE_TITLES: Record<PublicPage, string> = {
  about: 'Teddy Auth',
  privacy: '개인정보처리방침',
  terms: '이용약관',
  contact: '문의',
};
const PUBLIC_LINKS = [
  { page: 'about', label: '서비스 소개' },
  { page: 'privacy', label: '개인정보처리방침' },
  { page: 'terms', label: '이용약관' },
  { page: 'contact', label: '문의' },
] as const;

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

@Injectable()
export class PublicSiteService {
  constructor(private readonly config: ConfigService) {}

  policyVersions() {
    return { termsVersion: POLICY_VERSION, privacyVersion: POLICY_VERSION };
  }

  publicMetadata() {
    const mailProcessingRegions = this.setting(
      'AUTH_PUBLIC_MAIL_PROCESSING_REGIONS',
      '',
    );
    return {
      operatorName: this.setting('AUTH_PUBLIC_OPERATOR_NAME', '이경민'),
      supportEmail: this.setting(
        'AUTH_PUBLIC_SUPPORT_EMAIL',
        'lafamila325@gmail.com',
      ),
      privacyContactName: this.setting(
        'AUTH_PUBLIC_PRIVACY_CONTACT_NAME',
        '이경민',
      ),
      hostingCountry: this.setting('AUTH_PUBLIC_HOSTING_COUNTRY', '대한민국'),
      hostingProvider: this.setting(
        'AUTH_PUBLIC_HOSTING_PROVIDER',
        '운영자 개인 NAS 직접 호스팅',
      ),
      mailProvider: this.setting(
        'AUTH_PUBLIC_MAIL_PROVIDER',
        'Google Gmail SMTP',
      ),
      mailProcessingRegions: mailProcessingRegions || null,
      retention: privacyRetentionSettings(this.config),
      // These are disclosure details, not missing operator identity or approval.
      readiness: {
        operatorFactsConfirmed: true,
        mailProcessingRegionsConfirmed: Boolean(mailProcessingRegions),
        unconfirmedDetails: [
          ...(mailProcessingRegions
            ? []
            : ['AUTH_PUBLIC_MAIL_PROCESSING_REGIONS']),
          'mailProviderRetention',
        ],
      },
    };
  }

  decorate(html: string, layout: PublicSiteLayout = 'application'): string {
    if (
      html.includes('name="teddy-auth-public-site"') ||
      !/<\/head\s*>/i.test(html) ||
      !/<body\b[^>]*>/i.test(html) ||
      !/<\/body\s*>/i.test(html)
    )
      return html;

    const head = `
    <meta name="teddy-auth-public-site" content="1" />
    <meta name="application-name" content="Teddy Auth" />
    <link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
    <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
    <link rel="stylesheet" href="/public/assets/site.css" />
  `;
    const header =
      layout === 'form'
        ? `<header class="auth-site-form-header">${this.brand()}</header>`
        : '';
    // Append around the document, leaving scripts and form contents byte-for-byte intact.
    return html
      .replace(/<\/head\s*>/i, (closing) => head + closing)
      .replace(
        /<body\b([^>]*)>/i,
        (_opening, attributes: string) =>
          `<body${attributes} data-auth-site-layout="${layout}">${header}`,
      )
      .replace(/<\/body\s*>/i, (closing) => this.footer() + closing);
  }

  render(page: PublicPage): string {
    const title = PAGE_TITLES[page];
    const version =
      page === 'privacy'
        ? this.policyVersions().privacyVersion
        : page === 'terms'
          ? this.policyVersions().termsVersion
          : null;
    const content = {
      about: () => this.about(),
      privacy: () => this.privacy(),
      terms: () => this.terms(),
      contact: () => this.contact(),
    }[page]();
    return this.decorate(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Teddy Auth의 계정 인증 서비스와 이용약관, 개인정보 처리 및 문의 안내입니다." />
    <meta property="og:site_name" content="Teddy Auth" />
    <meta property="og:image" content="/brand/auth-logo-1024.png" />
    <title>${title}${page === 'about' ? '' : ' | Teddy Auth'}</title>
  </head>
  <body data-auth-public-page>
    <a class="auth-public-skip" href="#public-content">본문으로 건너뛰기</a>
    <header class="auth-public-header">
      <div class="auth-public-header-inner">
        ${this.brand()}
        <nav class="auth-public-nav" aria-label="공개 안내">${this.links(page)}<a href="/login">로그인</a></nav>
      </div>
    </header>
    <main class="auth-public-main" id="public-content" tabindex="-1">
      <div class="auth-public-heading">
        <h1>${title}</h1>
        ${version ? `<p class="auth-public-meta">시행일 및 버전 <time datetime="${version}">${version}</time></p>` : ''}
      </div>
      ${content}
    </main>
  </body>
</html>`);
  }

  private setting(key: string, fallback: string): string {
    const value = this.config.get<unknown>(key);
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  private brand(): string {
    return '<a class="auth-site-brand" href="/about" aria-label="Teddy Auth 서비스 소개"><img src="/brand/auth-logo-128.png" width="32" height="32" alt="" /><span>Teddy Auth</span></a>';
  }

  private links(current?: PublicPage): string {
    return PUBLIC_LINKS.map(
      ({ page, label }) =>
        `<a href="/${page}"${page === current ? ' aria-current="page"' : ''}>${label}</a>`,
    ).join('');
  }

  private emailLink(): string {
    const { supportEmail } = this.publicMetadata();
    return `<a href="${escapeHtml(`mailto:${encodeURIComponent(supportEmail)}`)}">${escapeHtml(supportEmail)}</a>`;
  }

  private footer(): string {
    return `<footer class="auth-site-footer" aria-label="Teddy Auth 안내">
      <div class="auth-site-footer-inner">
        ${this.brand()}
        <nav aria-label="약관 및 문의">${this.links()}</nav>
        <p>운영 ${escapeHtml(this.publicMetadata().operatorName)} · ${this.emailLink()}</p>
      </div>
    </footer>`;
  }

  private operatorDetails(): string {
    const metadata = this.publicMetadata();
    return `<dl class="auth-public-facts">
      <div><dt>서비스</dt><dd>Teddy Auth</dd></div>
      <div><dt>운영자</dt><dd>${escapeHtml(metadata.operatorName)}</dd></div>
      <div><dt>연락처</dt><dd>${this.emailLink()}</dd></div>
      <div><dt>개인정보 담당자</dt><dd>${escapeHtml(metadata.privacyContactName)}</dd></div>
      <div><dt>서버 운영</dt><dd>${escapeHtml(metadata.hostingCountry)} · ${escapeHtml(metadata.hostingProvider)}</dd></div>
      <div><dt>인증 메일 발송</dt><dd>${escapeHtml(metadata.mailProvider)}</dd></div>
    </dl>`;
  }

  private about(): string {
    return `<p class="auth-public-lead">연결된 서비스에서 사용하는 계정과 로그인을 관리하는 중앙 인증 서비스입니다.</p>
    <div class="auth-public-actions"><a class="auth-public-primary" href="/login">로그인</a><a href="/signup?return_to=%2Flogin">회원가입</a></div>
    <section class="auth-public-section" aria-labelledby="about-account">
      <h2 id="about-account">계정과 서비스 연결</h2>
      <p>이메일을 인증한 ID·비밀번호 또는 활성화된 소셜 로그인으로 계정을 이용합니다. Google, 카카오, 네이버 로그인은 실제 제공되는 화면에서 선택할 수 있습니다. 소셜 계정의 비밀번호를 Teddy Auth에 입력할 필요는 없습니다.</p>
      <p>로그인한 계정의 프로필, 연결된 로그인 수단과 서비스 이용 권한을 관리합니다. 연결된 서비스의 콘텐츠와 운영 정책은 각 서비스가 별도로 관리합니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="about-data">
      <h2 id="about-data">인증에 필요한 정보만</h2>
      <p>계정 확인, 로그인 보안, 서비스별 권한 확인에 필요한 정보를 처리합니다. 알림 기능을 사용하는 경우에만 등록 기기, 수신 동의와 알림함 정보를 추가로 처리합니다. 이 공개 사이트에는 광고나 방문자 분석 도구를 사용하지 않습니다.</p>
      <p>수집 항목과 외부 처리, 계정 탈퇴 범위는 <a href="/privacy">개인정보처리방침</a>에서 확인할 수 있습니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="about-operator">
      <h2 id="about-operator">운영 정보</h2>
      ${this.operatorDetails()}
    </section>`;
  }

  private privacy(): string {
    const metadata = this.publicMetadata();
    return `<p class="auth-public-lead">이 방침은 Teddy Auth의 계정 인증·권한 관리와 선택적으로 이용하는 알림 기능에 적용됩니다. 연결된 개별 서비스의 콘텐츠 처리는 각 서비스의 방침을 따릅니다.</p>
    <nav class="auth-public-contents" aria-label="개인정보처리방침 목차">
      <a href="#privacy-data">처리 항목</a><a href="#privacy-sharing">서비스 연결</a><a href="#privacy-external">호스팅·외부 처리</a><a href="#privacy-retention">보관·파기</a><a href="#privacy-rights">이용자 권리</a>
    </nav>
    <section class="auth-public-section" aria-labelledby="privacy-operator">
      <h2 id="privacy-operator">1. 운영자와 개인정보 문의</h2>
      ${this.operatorDetails()}
      <p>개인정보 열람·정정·삭제·처리 정지 및 동의 철회 요청은 ${this.emailLink()}로 접수합니다. 요청 내용과 본인 여부를 확인한 뒤 처리 범위, 제한 사유가 있는 경우 그 사유와 진행 결과를 안내합니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="privacy-data">
      <h2 id="privacy-data">2. 처리하는 정보와 목적</h2>
      <dl class="auth-public-data-list">
        <div><dt>계정 생성·본인 확인</dt><dd>내부 계정 식별자, 이름, 이메일, 이메일 인증 상태, 계정 상태와 생성·수정·최근 로그인 시각을 처리합니다. ID·비밀번호 방식을 선택한 경우 로그인 ID와 비밀번호 해시를 저장하며, 비밀번호 원문을 저장하지 않습니다. 소셜 전용 계정은 ID·비밀번호 없이 생성될 수 있습니다.</dd></div>
        <div><dt>소셜 로그인·연결</dt><dd>선택한 Google·카카오·네이버의 제공자 구분, 앱 식별자와 제공자별 계정 식별자, 제공받은 이름·이메일 및 이메일 검증 정보를 계정 확인과 연결에 사용합니다. 제공자 비밀번호, 연락처 목록, 메일함 내용은 요청하지 않습니다. 소셜 철회에 필요한 토큰의 임시 보관은 아래 보관·파기 항목에서 안내합니다.</dd></div>
        <div><dt>로그인 유지·권한 확인</dt><dd>로그인 세션, 인증 거래, 인가 코드·토큰 관련 기록, 서비스별 권한·등급과 이용 신청·처리 이력을 처리합니다. 관리자 OTP를 설정한 계정에 한해 암호화된 OTP 비밀키 등 관리자 인증 정보를 처리합니다.</dd></div>
        <div><dt>보안·부정 사용 방지</dt><dd>접속 IP 주소, 브라우저·기기 정보(User-Agent), 요청·인증 시각, 로그인 및 보안 작업 이력, 계정·권한 변경 감사 기록을 처리합니다. 이메일 인증에는 수신 이메일, 인증번호의 해시, 요청 IP, 시도 횟수, 만료·사용 상태가 포함됩니다.</dd></div>
        <div><dt>약관·개인정보 확인 이력</dt><dd>정책 확인을 제출한 경우 계정 또는 가입 거래에 연결된 약관·방침 버전, 공개 정책 내용의 식별값, 확인 시각과 목적 등 확인 이력을 처리합니다. 기존 가입자의 과거 동의가 있었던 것으로 소급하여 기록하지 않습니다.</dd></div>
        <div><dt>선택한 알림 기능</dt><dd>알림 앱·기기를 등록하거나 알림을 이용하는 경우에만 기기·설치 식별자, 기기 이름·플랫폼·앱 버전, 암호화된 푸시 토큰 및 토큰 지문, 마지막 연결 시각, 서비스별·기기별 수신 동의·철회 이력, 알림 제목·본문·연결 정보, 알림함과 전송 결과를 처리합니다. 모든 계정에 기기 등록이나 푸시 수신을 요구하지 않습니다.</dd></div>
        <div><dt>문의 처리</dt><dd>이메일 문의 시 발신 이메일, 문의 내용과 응대 내역을 처리합니다. 문의에 비밀번호, 인증번호, 개인키 또는 소셜 제공자 토큰을 포함하지 마세요.</dd></div>
      </dl>
      <p>정보는 이용자의 입력, 선택한 소셜 제공자의 인증 응답, 연결된 서비스의 인증·권한 요청 및 서비스 이용 과정에서 수집됩니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="privacy-sharing">
      <h2 id="privacy-sharing">3. 연결된 서비스와 정보 전달</h2>
      <p>이용자가 연결된 서비스에 로그인하면 등록된 서비스의 요청 범위에 따라 계정 식별자, 이름, 이메일·이메일 인증 상태, 로그인 ID 유무 등 프로필 정보와 해당 서비스의 이용 권한을 전달합니다. 각 서비스는 전달받은 정보와 자체 콘텐츠를 해당 서비스의 목적·방침에 따라 처리합니다.</p>
      <p>Teddy Auth의 비밀번호 해시, 관리자 OTP 비밀키와 소셜 제공자 토큰을 연결된 서비스에 제공하지 않습니다. 개인정보를 광고 목적으로 판매하거나 광고·방문자 분석 도구로 보내지 않습니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="privacy-external">
      <h2 id="privacy-external">4. 호스팅과 외부 처리</h2>
      <p>계정 데이터의 기본 저장·운영 환경은 ${escapeHtml(metadata.hostingCountry)}의 ${escapeHtml(metadata.hostingProvider)}입니다. 이 사실이 외부 이메일·소셜 로그인·푸시 제공자의 모든 처리가 국내에서 이루어짐을 뜻하지는 않습니다.</p>
      <h3>인증 메일 및 문의 이메일</h3>
      <p>${escapeHtml(metadata.mailProvider)}를 통해 인증 메일을 보냅니다. 수신 이메일 주소, 인증번호가 포함된 메일 본문과 발송에 필요한 정보가 Google에 전달됩니다. 문의를 이메일로 보내는 경우에도 문의 내용과 발신 주소가 메일 제공자를 통해 처리됩니다. Google의 글로벌 인프라를 이용하므로 국외 처리가 발생할 수 있습니다.</p>
      <p>공개된 메일 처리 지역 정보: <strong>${metadata.mailProcessingRegions ? escapeHtml(metadata.mailProcessingRegions) : '구체적인 처리 국가·지역은 확인되지 않았습니다.'}</strong> Google 측 보관 기간은 이 방침에서 특정 기간으로 보장하지 않습니다. <a href="https://policies.google.com/privacy?hl=ko" rel="noreferrer">Google 개인정보처리방침</a>에서 제공자의 설명을 확인할 수 있습니다.</p>
      <h3>소셜 제공자와 선택적 푸시</h3>
      <p>선택한 소셜 제공자는 로그인·연결·철회 요청을 자신의 정책에 따라 처리합니다. 알림 기기를 등록한 경우 푸시 전달을 위해 Google Firebase Cloud Messaging(FCM)에 기기 푸시 토큰과 알림 식별자를 전달합니다. iOS 푸시는 Apple 푸시 인프라를 거칠 수 있습니다. 알림 제목·본문은 Auth 알림함에서 조회하는 방식이며, Google·Apple 인프라에서도 국외 처리가 발생할 수 있습니다. 구체적인 처리 국가와 제공자 보관 기간을 임의로 확정하지 않습니다. <a href="https://firebase.google.com/support/privacy" rel="noreferrer">Firebase 개인정보·보안 안내</a>를 함께 확인할 수 있습니다.</p>
      <p class="auth-public-notice">외부 제공자의 세부 처리 국가·보관 기간은 별도 확인이 필요하며 확인된 내용에 따라 갱신합니다. 이 안내가 제공자의 검수 승인이나 법률 검토 완료를 의미하지는 않습니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="privacy-retention">
      <h2 id="privacy-retention">5. 보관·파기와 Auth 탈퇴 범위</h2>
      <p>계정 정보는 계정 유지와 인증·권한 관리에 필요한 동안 처리합니다. Auth 탈퇴 시 Auth 계정과 연결된 인증·권한·알림 데이터를 정리하고 Auth 로그인과 세션·토큰 사용을 종료합니다. 이는 모든 외부 시스템에서 모든 정보가 즉시 사라진다는 의미가 아닙니다.</p>
      <p>자동 연결 해제를 위해 필요한 외부 인증 토큰은 Auth 서버에서 암호화해 보관하며 브라우저에는 전달하지 않습니다. 연결 해제·탈퇴 후 철회에 재시도가 필요한 경우, 토큰과 최소 식별 정보를 암호화된 대기열에서 최대 24시간 보관합니다. 성공하거나 재시도가 종료되면 암호문을 삭제합니다. 제공자 장애로 철회가 끝나지 않으면 제공자의 연결된 서비스 관리에서 직접 해제가 필요할 수 있습니다.</p>
      <p><strong>Auth 탈퇴는 연결된 다른 서비스의 게시물, 파일, 게임 기록 등 콘텐츠 삭제를 포함하지 않습니다.</strong> 해당 데이터는 각 서비스에서 별도로 보관할 수 있으며 각 서비스의 탈퇴·삭제 절차나 운영자 문의를 통해 삭제를 요청해야 합니다. Auth 탈퇴 뒤에는 기존 계정으로 해당 서비스에 접근하지 못할 수 있으므로 필요한 콘텐츠를 먼저 확인하세요.</p>
      <p>선택적 알림의 현재 자동 정리 기준은 전송 시도 기록 30일, 알림 및 비활성 기기 90일입니다. 알림의 생성·삭제 또는 기기 비활성 시각에 따라 주기적으로 정리되며, 이 기간은 Google·Apple 측 보관 기간을 뜻하지 않습니다.</p>
      <p>인증·가입 임시 데이터의 정리 기준은 ${metadata.retention.authDataRetentionHours}시간, 보안·접속 감사로그는 ${metadata.retention.auditRetentionDays}일이며 서버에서 주기적으로 정리합니다. 계정 탈퇴 시 해당 계정의 개인정보가 담긴 감사 기록은 삭제 또는 비식별 처리합니다. Auth DB 백업의 운영 보관 기준은 ${metadata.retention.backupRetentionDays}일이며 NAS 운영자가 보관·정리를 관리합니다. 기존 보존 백업과 외부 메일 기록은 화면에서 즉시 지워지지 않을 수 있으므로 담당자에게 삭제 처리를 요청할 수 있습니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="privacy-rights">
      <h2 id="privacy-rights">6. 이용자의 권리와 요청 방법</h2>
      <p>본인 정보의 열람, 잘못된 정보의 정정, 삭제·탈퇴, 처리 정지와 선택적 동의 철회를 ${this.emailLink()}로 요청할 수 있습니다. 계정과 요청 대상을 확인하는 데 필요한 최소한의 본인 확인을 요청할 수 있으며, 확인 결과와 처리 방법을 안내합니다. 비밀번호나 인증번호 원문을 이메일로 요구하지 않습니다.</p>
      <p>이름·현재 로그인 ID처럼 화면에서 직접 수정할 수 없는 항목도 문의를 통한 정정 요청이 가능합니다. 요청 가능 여부와 화면의 수정 가능 여부는 다릅니다. 이메일·비밀번호 변경 등 직접 제공되는 기능은 로그인 후 <a href="/profile">내 정보</a>에서도 이용할 수 있습니다.</p>
      <p>소셜 연결 해제 시에는 다른 로그인 수단을 먼저 확보해야 합니다. 마지막 로그인 수단은 단순 연결 해제로 제거할 수 없으며, 계정 전체 이용 종료는 Auth 탈퇴 절차를 이용합니다. 마지막 활성 최고 관리자 계정의 탈퇴는 운영 권한 인계 전까지 제한됩니다. 이 경우에도 개인정보 관련 요청은 담당자가 접수하고 처리 범위와 제한 사유를 안내합니다.</p>
      <p>필수 인증 정보를 제공하지 않으면 계정 생성·로그인이 어려울 수 있습니다. 알림 수신 동의는 선택이며 철회해도 기본 인증 서비스 이용과는 별개입니다. 연결된 다른 서비스에 보관된 데이터에 대한 권리 요청은 해당 서비스에도 별도로 제출해야 합니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="privacy-security">
      <h2 id="privacy-security">7. 쿠키와 안전한 처리</h2>
      <p>로그인 세션 유지, 인증 거래의 브라우저 연결 및 위조 요청 방지를 위한 필수 쿠키를 사용합니다. 브라우저에서 쿠키를 차단하거나 삭제할 수 있지만 로그인·인증이 정상적으로 진행되지 않을 수 있습니다. 광고·분석용 쿠키는 사용하지 않습니다.</p>
      <p>비밀번호 해시, 필요한 비밀정보의 암호화, 접근 권한 제한, 관리자 추가 인증, 일회성 인증 거래와 보안 기록 등으로 정보를 보호합니다. 이러한 조치가 모든 위험의 제거를 보장하지는 않습니다. 공개 안내 페이지를 열기 위해 로그인하거나 소셜 제공자에게 연결할 필요는 없습니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="privacy-changes">
      <h2 id="privacy-changes">8. 방침 변경</h2>
      <p>처리 항목·목적·운영 환경이 바뀌면 이 페이지의 내용과 버전을 갱신합니다. 필요한 경우 기존 계정에도 변경된 약관·방침의 확인을 요청할 수 있습니다. 과거 가입자의 확인 이력을 임의로 만들지 않습니다.</p>
    </section>`;
  }

  private terms(): string {
    return `<p class="auth-public-lead">이 약관은 운영자 ${escapeHtml(this.publicMetadata().operatorName)}이 제공하는 Teddy Auth 계정 인증 서비스의 이용 범위와 이용자·운영자의 기본 사항을 안내합니다.</p>
    <section class="auth-public-section" aria-labelledby="terms-service">
      <h2 id="terms-service">1. 서비스와 적용 범위</h2>
      <p>Teddy Auth는 계정 생성, 이메일 확인, ID·비밀번호 및 활성화된 소셜 로그인, 연결된 서비스의 본인 확인·이용 권한 관리와 선택적 알림 기능을 제공합니다. 개별 서비스의 콘텐츠·거래·게임 진행은 해당 서비스의 약관과 운영 정책을 따릅니다.</p>
      <p>소셜 제공자의 정책과 연결된 서비스의 이용 조건에 따라 특정 인증 방식의 이용이 제한될 수 있습니다. 로그인 버튼이 제공된다는 사실이 제공자의 검수·승인이나 모든 서비스에서의 이용 가능성을 보장하지 않습니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="terms-account">
      <h2 id="terms-account">2. 계정 생성과 관리</h2>
      <p>이용자는 본인이 사용할 수 있는 이메일과 정확한 계정 정보를 제공하고 필요한 이메일 확인 및 정책 확인 절차를 진행합니다. 소셜 전용 계정은 별도 ID·비밀번호 없이 생성될 수 있으며, 이후 제공되는 본인 확인 절차를 거쳐 다른 로그인 수단을 추가할 수 있습니다.</p>
      <p>비밀번호, 인증번호와 로그인 수단을 타인에게 넘기거나 다른 사람의 계정을 사용해서는 안 됩니다. 계정 도용이 의심되면 즉시 비밀번호·연결 상태를 확인하고 운영자에게 알려 주세요. 서비스별 이용 권한은 계정 가입만으로 모두 부여되지 않습니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="terms-use">
      <h2 id="terms-use">3. 이용 시 지켜야 할 사항</h2>
      <p>다른 이용자를 사칭하거나 개인정보를 부정하게 사용해서는 안 됩니다. 인증·권한 확인을 우회하는 행위, 계정·인증번호의 자동 대량 생성, 시스템 침해, 서비스 가용성을 훼손하는 요청과 타인의 권리를 침해하는 행위를 금지합니다.</p>
      <p>운영자는 보안 위험이나 부정 사용이 확인되면 관련 로그인·계정·서비스 권한을 제한할 수 있습니다. 이용자는 ${this.emailLink()}로 제한 사유의 확인과 이의를 요청할 수 있고, 운영자는 보안상 공개할 수 없는 내용을 제외한 확인 결과를 안내합니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="terms-unlink">
      <h2 id="terms-unlink">4. 소셜 연결 해제와 Auth 탈퇴</h2>
      <p>연결 해제는 특정 소셜 로그인 수단을 계정에서 분리하는 절차이며 Auth 계정 전체 탈퇴와 다릅니다. 로그인 불능을 막기 위해 마지막 로그인 수단의 단순 연결 해제는 허용되지 않습니다. 계정 이용을 종료하려면 Auth 탈퇴 절차를 이용해야 합니다. 민감한 변경에는 최근 본인 인증 등 추가 확인이 요구될 수 있습니다.</p>
      <p>Auth 탈퇴 시 Auth 계정과 인증·권한·알림 데이터를 정리하고 로그인 수단을 종료합니다. 제공자 철회가 실패하면 암호화된 토큰과 필요한 최소 정보를 재시도 목적으로 일시 보관할 수 있으며, 완료 또는 재시도 종료 후 정리합니다. 외부 제공자의 처리 지연이나 별도 보관 기록은 <a href="/privacy#privacy-retention">개인정보처리방침</a>을 따릅니다.</p>
      <p><strong>연결된 다른 서비스의 콘텐츠는 Auth 탈퇴만으로 삭제되지 않고 별도로 보관될 수 있습니다.</strong> 해당 서비스의 삭제 절차를 별도로 이용해야 하며, Auth 탈퇴 전에 필요한 자료와 접근 방법을 확인해야 합니다. 마지막 활성 최고 관리자 계정은 관리 권한을 인계하기 전까지 탈퇴할 수 없습니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="terms-availability">
      <h2 id="terms-availability">5. 제공 환경과 중단</h2>
      <p>이 서비스는 개인 운영자의 국내 NAS 환경에서 운영됩니다. 점검·장애·보안 조치 또는 외부 인증·메일·푸시 제공자의 사정으로 일부 기능이 중단되거나 변경될 수 있습니다. 운영자는 확인된 문제를 조치하고 이용에 중요한 변경이나 중단은 가능한 범위에서 안내합니다.</p>
      <p>서비스가 항상 중단 없이 제공된다고 약속하지 않습니다. 이 문서가 운영자의 책임을 일률적으로 면제하거나 이용자의 권리 행사를 제한하는 의미는 아닙니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="terms-privacy">
      <h2 id="terms-privacy">6. 개인정보와 정책 변경</h2>
      <p>개인정보 처리 항목, 외부 제공자와 보관·삭제 범위는 <a href="/privacy">개인정보처리방침</a>에서 안내합니다. 선택적 알림은 기기·서비스별 수신 동의에 따라 제공되며 이용자는 수신 동의를 철회할 수 있습니다.</p>
      <p>약관이 변경되면 이 페이지에 새 내용과 버전을 표시합니다. 필요한 경우 기존 이용자에게도 변경 정책의 확인을 요청할 수 있습니다. 변경 내용에 문의하거나 계정 이용을 종료하려면 운영자에게 연락할 수 있습니다.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="terms-contact">
      <h2 id="terms-contact">7. 문의와 문제 해결</h2>
      <p>계정·권한·약관 관련 문의와 이의는 ${this.emailLink()}로 보내 주세요. 운영자는 요청의 사실관계와 계정 소유 여부를 확인하고 처리 결과를 안내합니다. 연결된 서비스 자체의 콘텐츠 문제는 해당 서비스 운영자에게도 문의해야 합니다.</p>
    </section>`;
  }

  private contact(): string {
    return `<p class="auth-public-lead">계정 이용과 개인정보 관련 요청을 운영자에게 직접 보낼 수 있습니다.</p>
    ${this.operatorDetails()}
    <section class="auth-public-section" aria-labelledby="contact-account">
      <h2 id="contact-account">계정·로그인 문의</h2>
      <p>${this.emailLink()}로 사용 중인 이메일, 문제가 발생한 화면과 발생 시각, 필요한 조치를 알려 주세요. 계정 소유 확인에 필요한 사항은 답변으로 안내합니다. 비밀번호, 이메일 인증번호, OTP, 비밀키와 토큰은 보내지 마세요.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="contact-privacy">
      <h2 id="contact-privacy">개인정보 관련 요청</h2>
      <p>열람, 정정, 삭제·탈퇴, 처리 정지와 동의 철회 요청을 같은 이메일로 접수합니다. 화면에서 직접 바꿀 수 없는 이름·로그인 ID의 정정도 요청할 수 있으며, 확인 후 처리 가능 범위와 결과를 안내합니다. 자세한 처리 범위는 <a href="/privacy#privacy-rights">이용자 권리 안내</a>를 확인해 주세요.</p>
    </section>
    <section class="auth-public-section" aria-labelledby="contact-scope">
      <h2 id="contact-scope">연결된 서비스의 데이터</h2>
      <p>Auth 계정 탈퇴와 다른 서비스의 콘텐츠 삭제는 별개입니다. 게시물·파일·게임 기록 등의 삭제는 해당 서비스에 별도로 요청해야 합니다. 어떤 서비스에 요청해야 하는지 알기 어려우면 서비스 이름과 삭제하려는 데이터 종류를 알려 주세요.</p>
    </section>`;
  }
}
