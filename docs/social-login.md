# 소셜 로그인 등록 및 운영 가이드

공식 자료 확인일: **2026-11-04**. Google, Kakao, Naver의 공식 문서와 공지만 참고했다. 콘솔의 언어, 계정 유형, 권한, 개편 시점에 따라 메뉴 이름과 위치가 다를 수 있으므로 각 절의 공식 링크도 함께 확인한다.

이 문서는 운영자가 제공자 계정과 개발자 앱을 등록하고, 발급받은 값을 **중앙 `auth-api-nest` 백엔드**에 설정하기 위한 안내다. 아래 가입 정책은 2026-11-04 사용자 승인 사항이며, 제공자가 모든 이메일의 현재 소유권을 보증한다는 의미는 아니다. 배포와 실계정 테스트 절차는 수행할 작업을 설명한 것으로, 키 발급, 검수 승인, migration 실행 또는 실제 제공자 smoke test 완료 보고가 아니다.

## 1. 먼저 구분할 두 종류의 로그인

```text
서비스 웹/네이티브 앱
  -> 중앙 Auth /oauth/authorize
  -> 중앙 Auth 로그인 화면에서 Google / Kakao / Naver 선택
  -> 제공자 로그인 및 정보 제공 동의
  -> 중앙 Auth /oauth/social/{provider}/callback
  -> 필요한 이메일 인증 또는 신규 가입 정보 확인
  -> 기존 중앙 OIDC 요청 재개
  -> 원래 등록된 서비스/BFF/네이티브 callback
```

- 제공자 입장에서 OAuth 클라이언트는 중앙 Auth 웹 서버다. 제공자의 인가 코드는 중앙 Auth가 서버에서 교환한다.
- 제공자 콘솔에는 Todo 프런트엔드, Todo API callback, 개별 앱 custom scheme을 소셜 callback으로 등록하지 않는다.
- 서비스가 중앙 Auth에 등록한 기존 OIDC client, callback, `state`, PKCE와 앱 복귀 방식은 별개의 계약이며 유지한다. 세부 계약은 [기존 Auth 흐름](./auth-flows.md)과 [서비스 통합 문서](./service-integration.md)를 따른다.
- Google/Kakao/Naver 키는 중앙 Auth에만 설정한다. 프런트엔드용 SDK 키, 네이티브 제공자 SDK, 앱별 제공자 client를 추가하는 방식이 아니다.

웹 서버가 secret과 로그인 상태를 보관하는 흐름은 [Google 웹 서버 OAuth 가이드](https://developers.google.com/identity/protocols/oauth2/web-server), [Kakao REST API](https://developers.kakao.com/docs/ko/kakaologin/rest-api), [Naver 개발 가이드](https://developers.naver.com/docs/login/devguide/devguide.md)를 참고한다.

## 2. 승인된 가입 및 계정 연결 정책

### 2.1 이메일 인증과 자동 연결

처음 보는 소셜 identity는 다음 정책으로 이메일 소유 확인을 마친 후 기존 계정을 찾거나 새 계정을 만든다. 제공자 응답은 중앙 Auth가 서버에서 검증하며, 브라우저가 제출한 이메일이나 인증 플래그를 그대로 신뢰하지 않는다.

| 제공자 응답 | 서비스의 신뢰 판정 | 첫 연결/가입 시 처리 |
| --- | --- | --- |
| Google: 이메일 존재, `email_verified === true`, `@gmail.com` 주소 | 신뢰 가능 | 별도 이메일 OTP 없이 같은 이메일의 기존 계정에 자동 연결, 없으면 신규 가입 |
| Google: 이메일 존재, `email_verified === true`, 응답의 `hd` 존재 | 신뢰 가능 | 위와 동일. `hd` 요청 힌트나 이메일 도메인 추측으로 대신하지 않음 |
| Google: 비-Gmail이고 `hd` 없음 | 기본 `false` | `email_verified`가 참이어도 자체 이메일 OTP 후 연결/가입 |
| Kakao: 이메일 존재, `is_email_valid === true`와 `is_email_verified === true` 모두 충족 | 승인된 정책상 신뢰 가능 | 별도 이메일 OTP 없이 같은 이메일의 기존 계정에 자동 연결, 없으면 신규 가입 |
| Kakao: 둘 중 하나가 거짓, 누락 또는 문자열 등 올바른 boolean이 아님 | `false` | 자체 이메일 OTP 후 연결/가입 |
| Naver: 프로필 이메일 수신 여부와 무관 | 기본 `false` | 자체 이메일 OTP 후 연결/가입. `@naver.com`만으로 예외 처리하지 않음 |
| 모든 제공자: 이메일 없음 | `false` | 사용자가 이메일을 입력하고 자체 OTP를 완료한 뒤 연결/가입 |

Google은 Gmail 또는 검증된 Workspace `hd` 조합에서 이메일에 대한 권위를 가진다고 설명한다. 외부 이메일은 최초 확인 이후 소유자가 바뀌었을 수 있다. [Google ID 토큰 검증 가이드](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)를 기준으로 한다.

Kakao는 이메일 유효/인증 여부를 별도로 제공하지만 이메일을 동일 사용자 판정 기준으로 사용하는 것은 권장하지 않는다. 위의 strict flag 조합을 통한 첫 자동 연결은 **이 서비스가 승인한 위험 수용 정책**이며, Google의 authoritative 판정과 같은 보장을 뜻하지 않는다. 필드 정의는 [Kakao REST API](https://developers.kakao.com/docs/ko/kakaologin/rest-api), 주의 사항은 [Kakao 로그인 이해하기](https://developers.kakao.com/docs/ko/kakaologin/common)를 참고한다.

Naver 프로필 명세에는 이메일 인증 여부가 없고, 이메일은 외부 주소로 바뀔 수 있다. 이는 "Naver가 이메일을 전혀 인증하지 않는다"는 단정이 아니라 **이 연동에서 사용할 검증 증명이 노출되지 않는다**는 뜻이다. [Naver 프로필 명세](https://developers.naver.com/docs/login/profile/profile.md)를 참고한다.

### 2.2 선택 ID와 비밀번호

- **새 계정에서 ID를 비우면** 소셜 전용 계정을 만든다. `login_id`와 `password_hash`는 모두 `NULL`이며, 숨겨진 임의 ID나 임의 비밀번호를 생성하지 않는다.
- **ID를 입력한 경우에만** ID 중복 확인, 비밀번호, 비밀번호 확인이 필요하다. 두 비밀번호가 일치하고 기존 비밀번호 정책을 만족해야 한다.
- ID와 비밀번호를 만들지 않아도 소셜 가입을 끝낼 수 있어야 한다. 일반 ID/PW 가입 화면의 필수 조건을 소셜 가입에 그대로 적용하지 않는다.
- 같은 이메일의 기존 계정에 연결할 때 기존 ID, 비밀번호, 권한을 새 가입 입력값으로 덮어쓰지 않는다.
- 소셜 전용 계정은 로컬 ID/PW 로그인을 사용할 수 없다. 이후 로컬 자격 증명을 추가하는 기능이 별도로 없다면 이 문서를 그 기능의 제공 약속으로 해석하지 않는다.

이는 이 서비스의 승인된 계약이다. 특히 Naver의 별도 비밀번호 요구 금지 기준과 검수 자료 구성은 [Naver 사전 검수 가이드](https://developers.naver.com/docs/login/verify/verify.md)에 따른다.

### 2.3 이후 로그인과 권한

첫 연결이 끝나면 **제공자, provider client, 안정적인 subject**의 매핑으로 같은 중앙 계정 UUID를 찾는다. Google은 `sub`, Kakao는 회원번호, Naver는 애플리케이션별 식별자가 기준이다. 나중에 제공자 이메일이 달라져도 identity를 다른 중앙 계정으로 옮기거나 이메일만으로 다시 병합하지 않는다.

여러 제공자가 같은 계정에 연결되면 모두 같은 중앙 계정 UUID로 로그인한다. 이메일 OTP가 필요한 제공자는 OTP 완료 전에는 기존 계정을 연결하지 않는다. 활성 상태, 비밀번호 재설정 요구, 관리자 OTP와 서비스 권한 정책은 우회하지 않는다.

가입/소셜 연결만으로 `account-service` 권한 행을 미리 만들지 않는다. 이후 활성 서비스의 실제 OIDC 로그인 과정에서 기존 정책대로 필요한 경우에만 `visitor`가 지연 생성된다. 따라서 "가입 직후"와 "서비스 복귀까지 완료한 뒤"의 권한 행 수는 다를 수 있다.

식별자 특성은 [Google 검증 문서](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [Kakao 회원 식별 기준](https://developers.kakao.com/docs/ko/kakaologin/common), [Naver 프로필 식별자](https://developers.naver.com/docs/login/profile/profile.md)를 참고한다.

## 3. 운영과 로컬 callback 준비

### 3.1 콘솔에 등록할 정확한 URL

callback은 `ISSUER_URL`을 기준으로 Auth가 결정한다. 제공자별 별도 callback env는 사용하지 않는다. `{provider}`나 `{google|kakao|naver}`를 문자 그대로 등록하지 말고, 아래의 실제 제공자 경로를 등록한다.

| 제공자 | 운영: `ISSUER_URL=https://auth.lafamila.xyz` | 로컬 예시: `ISSUER_URL=http://localhost:3032` |
| --- | --- | --- |
| Google | `https://auth.lafamila.xyz/oauth/social/google/callback` | `http://localhost:3032/oauth/social/google/callback` |
| Kakao | `https://auth.lafamila.xyz/oauth/social/kakao/callback` | `http://localhost:3032/oauth/social/kakao/callback` |
| Naver | `https://auth.lafamila.xyz/oauth/social/naver/callback` | `http://localhost:3032/oauth/social/naver/callback` |

프로토콜, 호스트, 포트, 경로와 trailing slash를 실제 요청과 맞춘다. `localhost`와 `127.0.0.1`을 섞지 않는다. `/api` 접두사나 `/`를 임의로 덧붙이지 않는다. 리버스 프록시는 위 Auth 경로를 그대로 백엔드로 전달해야 한다.

등록 규칙은 [Google redirect URI 규칙](https://developers.google.com/identity/protocols/oauth2/web-server), [Kakao 키별 redirect URI 설정](https://developers.kakao.com/docs/ko/app-setting/app), [Naver 웹 환경 등록](https://developers.naver.com/docs/common/openapiguide/appregister.md)을 참고한다.

### 3.2 개발 환경을 운영과 분리하기

운영 계정 DB를 로컬 테스트 대상으로 사용하지 않는다. 가능한 경우 개발용 제공자 프로젝트/앱 또는 분리된 키와 개발용 Auth DB를 사용한다. 별도 앱/client의 subject namespace는 운영과 다를 수 있으므로 개발 identity 매핑을 운영 DB로 복사하지 않는다.

로컬 포트가 3032가 아니면 실제 브라우저 접근 주소로 `ISSUER_URL`을 맞추고 모든 제공자 콘솔의 로컬 callback을 변경한다. 이것은 중앙 OIDC issuer 변경이기도 하므로 테스트 소비 서비스의 issuer/discovery 설정도 함께 맞춰야 한다. 운영 issuer를 로컬 주소로 바꾸지 않는다.

로컬 URL의 허용 여부는 각 콘솔에서 확인한다. 허용되지 않는 환경에는 검증 가능한 개발용 HTTPS Auth 도메인을 사용한다. 휴대전화에서 `localhost`는 개발 Mac이 아니라 **휴대전화 자신**을 뜻하므로 실기기 테스트에는 휴대전화가 접근할 수 있는 HTTPS Auth 주소가 필요하다. 임의 LAN IP의 HTTP가 모든 제공자에서 허용된다고 가정하지 않는다.

환경 분리와 브라우저 사용 기준은 [Google 운영 준비 기준](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)과 [OAuth 권장 사항](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)을 참고한다.

## 4. Auth 백엔드 환경 변수

| 제공자 | Client ID 환경 변수 | Client Secret 환경 변수 |
| --- | --- | --- |
| Google | `SOCIAL_GOOGLE_CLIENT_ID` | `SOCIAL_GOOGLE_CLIENT_SECRET` |
| Kakao | `SOCIAL_KAKAO_CLIENT_ID` | `SOCIAL_KAKAO_CLIENT_SECRET` |
| Naver | `SOCIAL_NAVER_CLIENT_ID` | `SOCIAL_NAVER_CLIENT_SECRET` |

발급값을 넣기 전의 운영 설정 형태는 다음과 같다. 아래 빈 값은 가짜 자격 증명이 아니라 **제공자 비활성 상태**다.

```dotenv
ISSUER_URL=https://auth.lafamila.xyz
RUN_MIGRATIONS=true

SOCIAL_GOOGLE_CLIENT_ID=
SOCIAL_GOOGLE_CLIENT_SECRET=
SOCIAL_KAKAO_CLIENT_ID=
SOCIAL_KAKAO_CLIENT_SECRET=
SOCIAL_NAVER_CLIENT_ID=
SOCIAL_NAVER_CLIENT_SECRET=
```

각 제공자는 ID/Secret **한 쌍을 모두** 설정한다. 사용하지 않는 제공자는 두 값을 모두 비운다. 한쪽만 채운 상태는 설정 누락이므로 정상 활성화로 간주하지 않는다. 사용 중인 다른 제공자는 끌 필요가 없다. 로컬에서는 `ISSUER_URL`만 실제 개발 Auth 주소로 바꾸고 개발용 발급 쌍을 사용한다.

이 값들은 서버의 런타임 환경/secret 관리 체계에만 보관한다. `NEXT_PUBLIC_*`, `VITE_*`, Flutter `--dart-define`, Swift 설정, JavaScript bundle, HTML, 앱 배포 파일에 넣지 않는다. Client ID가 인가 요청에 나타나는 것은 정상이나, 프런트엔드에서 키를 관리하거나 secret을 노출할 이유가 되지 않는다. 새 Google 서비스 계정 키, Kakao JavaScript/네이티브 키, Naver 모바일 SDK 키는 필요하지 않다.

기존 `COOKIE_SECRET`, `SIGNUP_EMAIL_CODE_PEPPER`, `ADMIN_OTP_ENCRYPTION_KEY`, DB, SMTP 등의 보안 설정은 유지한다. 이 기능을 켠다는 이유로 기존 값을 재생성하거나 개발 기본값으로 대체하지 않는다. 신뢰 불충분 이메일은 OTP가 필요하므로 운영 SMTP도 준비되어 있어야 한다.

secret 비공개 원칙은 [Google client 보관 지침](https://support.google.com/cloud/answer/15549257?hl=en), [Kakao REST API 키 설정](https://developers.kakao.com/docs/ko/app-setting/app), [Naver Client ID/Secret 안내](https://developers.naver.com/docs/login/devguide/devguide.md)를 참고한다.

## 5. Google 등록 절차

### 5.1 Google 계정과 Cloud 프로젝트

1. Google 계정이 없다면 Google 로그인 화면의 계정 만들기로 가입한다. 운영 담당자가 접근할 수 있는 계정과 연락처를 사용한다.
2. [Google Cloud Console](https://console.cloud.google.com/)에 로그인하고 프로젝트 선택기에서 중앙 Auth용 프로젝트를 생성하거나 선택한다.
3. 조직 소유 프로젝트라면 적절한 관리 권한을 받고, 담당자 변경에도 접근권이 남도록 운영 주체가 소유권을 관리한다.
4. Google Auth Platform을 연다. 초기 화면이면 Get Started로 앱 등록을 시작한다. 개발/운영 프로젝트는 가능하면 분리한다.

Google 앱 등록의 공식 시작점은 [Google Auth Platform 설정](https://developers.google.com/workspace/guides/configure-oauth-consent)과 [OAuth client 생성](https://support.google.com/cloud/answer/15549257?hl=en)이다. 이 서버 로그인만을 위해 Gmail/Drive API 접근 권한이나 서비스 계정을 만들 필요는 없다.

### 5.2 앱 이름, 동의 화면과 테스트 사용자

1. Branding에서 중앙 Auth를 식별할 앱 이름, 지원 이메일과 개발자 연락처를 입력한다. 사용자에게 보이는 브랜드와 실제 로그인 서비스를 일치시킨다.
2. 운영 홈페이지, 개인정보 처리방침과 필요한 약관 URL을 준비한다. 존재하지 않는 문서 URL을 입력하지 않는다.
3. Audience에서 사용자를 정한다. 일반 Gmail 사용자까지 받으려면 External이 필요하다. Internal은 해당 조직 사용자로 제한된다.
4. 개발 중에는 Audience의 Test users에 테스트 Google 계정을 추가한다. Testing 상태의 제한과 해당 계정의 로그인 허용 여부를 확인한다.
5. Data Access에는 실제 로그인에 필요한 최소 범위인 `openid`, 이메일, 필요한 프로필 범위만 선언한다. 메일함 읽기나 연락처 권한을 추가하지 않는다.

메뉴와 입력 절차는 [Google 동의 화면 설정](https://developers.google.com/workspace/guides/configure-oauth-consent), 브랜드 필드의 의미는 [OAuth App Branding](https://support.google.com/cloud/answer/15549049)을 참고한다.

### 5.3 Web application client와 키 발급

1. Google Auth Platform의 Clients에서 Create Client를 선택한다.
2. 유형은 **Web application**으로 지정한다. 중앙 Auth가 secret을 보관하므로 Android, iOS, Desktop 앱 유형이 아니다.
3. 환경을 구분할 client 이름을 입력한다. Authorized redirect URIs에 해당 환경의 `/oauth/social/google/callback` 전체 URL을 추가한다.
4. 생성 후 Client ID를 `SOCIAL_GOOGLE_CLIENT_ID`에, Client Secret을 `SOCIAL_GOOGLE_CLIENT_SECRET`에 설정한다.
5. Secret은 생성 시점에만 전체 값을 확인/다운로드할 수 있으므로 승인된 secret 저장소에 바로 보관한다. 이후 콘솔에서 다시 전체 값을 볼 수 있다고 가정하지 않는다.
6. 이 서버 코드 플로우에는 브라우저용 Google SDK나 Authorized JavaScript origins 추가가 필요하지 않다. origins와 redirect URIs는 다른 필드다.

발급과 secret 표시 정책은 [현재 OAuth client 관리 문서](https://support.google.com/cloud/answer/15549257?hl=en), 서버 코드 교환은 [웹 서버 OAuth 가이드](https://developers.google.com/identity/protocols/oauth2/web-server)를 참고한다.

### 5.4 운영 공개와 검증

1. 실제 운영 도메인을 Authorized domains에 등록하고 필요한 도메인 소유 확인을 진행한다. `auth.lafamila.xyz`의 상위 등록 가능 도메인은 `lafamila.xyz`다.
2. 외부 공개와 이름/로고 표시 조건에 맞춰 Branding의 Verify Branding을 진행한다. 승인 후 Publish branding까지 완료했는지 확인한다.
3. Audience의 공개 상태와 브랜드 게시 상태를 각각 확인한다. 브랜드 게시만으로 테스트 사용자 제한이 해제되었다고 보지 않는다.
4. 민감/제한 범위를 추가했다면 Verification Center에서 추가 요구를 확인한다. 기본 로그인 범위만 쓰는 서비스와 추가 Google 데이터 API 심사를 혼동하지 않는다.
5. 운영 승인 상태에서 일반 계정으로 실제 로그인을 확인한다. Workspace 조직 관리자 정책 때문에 별도 차단될 수 있다.

공개 전 검증 조건은 [Google 브랜드 검증 가이드](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)에 설명되어 있다. 심사 완료 시점은 보장하지 않는다.

### 5.5 이메일 신뢰와 Secret 교체

서버는 인증 응답의 발급자, 대상 client, 유효기간 등과 ID 토큰을 사용할 경우 서명/nonce를 검증해야 한다. 이메일 OTP 생략은 2.1절 조건에만 적용한다. 특히 외부 주소의 Google 계정은 `email_verified=true`만으로 자동 연결하지 않는다. 근거는 [Google 이메일 권위 판정](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)이다.

Secret 분실/노출/정기 교체 시 같은 client의 Add Secret으로 새 값을 발급하고, Auth 환경을 바꿔 재배포한 뒤 이전 secret을 Disable하고 마지막에 삭제한다. 겹치는 기간을 이용해 서버 전체가 새 값을 쓰는지 확인한다. 새 client ID를 만드는 것과 secret만 교체하는 것은 다르다. [현재 Secret rotation 절차](https://support.google.com/cloud/answer/15549257?hl=en)를 따른다.

## 6. Kakao 등록 절차

### 6.1 카카오계정, 개발자 가입과 앱 브랜드

1. 카카오계정이 없다면 카카오계정 로그인 화면에서 가입한다. [Kakao Developers](https://developers.kakao.com/)에 로그인하고 첫 이용 시 표시되는 약관/개발자 정보 등록을 마친다.
2. 앱 관리에서 앱을 만든다. 중앙 Auth 서비스 이름, 운영 주체, 카테고리와 실제 대표 도메인을 준비한다.
3. 앱 기본 정보에 서비스와 일치하는 이름과 아이콘을 등록한다. 사용자 동의 화면에서 누구에게 정보를 제공하는지 알아볼 수 있어야 한다.
4. 이 웹 서버 로그인에 사용할 앱이라는 점을 확인한다. Android 패키지명, 서명 키 해시, iOS bundle ID를 새로 등록하는 작업은 포함하지 않는다.

앱 생성은 [Kakao 시작하기](https://developers.kakao.com/docs/ko/tutorial/start), 브랜드 항목은 [앱 기본 정보](https://developers.kakao.com/docs/ko/app-setting/app)를 참고한다.

### 6.2 로그인 활성화와 현재 키 메뉴

1. **카카오 로그인 > 사용 설정**에서 상태를 ON으로 둔다.
2. **앱 > 플랫폼 키 > REST API 키**에서 사용할 키를 선택한다. env에 넣을 `client_id`는 이 REST API 키의 값이다. 숫자 앱 ID, JavaScript 키나 어드민 키가 아니다.
3. 선택한 키의 **카카오 로그인 리다이렉트 URI**에 해당 환경의 `/oauth/social/kakao/callback` 전체 URL을 입력하고 저장한다.
4. 같은 REST API 키의 **클라이언트 시크릿**에서 활성화 상태와 코드를 확인한다. 이 키와 연결된 secret을 `SOCIAL_KAKAO_CLIENT_SECRET`에 설정한다.
5. REST API 키를 `SOCIAL_KAKAO_CLIENT_ID`에 설정한다. 다른 키의 callback이나 secret을 섞지 않는다.

2025-12-03 개편 후 callback과 secret은 **키별 설정**이다. 예전 튜토리얼의 `카카오 로그인 > 일반` 또는 `고급 > 보안`에서 찾지 않는다. 새 REST API 키는 자동 생성된 키를 포함해 client-secret 보호가 기본 활성 상태이므로 서버의 token 요청에 `client_secret`이 필요하다. [개편 공지 문서](https://developers.kakao.com/docs/ko/getting-started/app-key-migration), [로그인 활성화/Secret 안내](https://developers.kakao.com/docs/ko/kakaologin/prerequisite)를 참고한다.

### 6.3 이메일 동의 권한과 Biz 앱

1. **카카오 로그인 > 동의항목**에서 카카오계정 이메일(`account_email`)을 확인한다.
2. 이용 목적은 실제 서비스의 계정 식별/연결 및 이메일 사용 방식에 맞춰 입력하고 허용된 동의 단계로 설정한다. 없는 권한을 요청 URL의 `scope`만 추가해 얻을 수는 없다.
3. 현재 공식 표는 이메일의 필수/선택/이용 중 동의 권한 대상으로 **비즈 앱과 테스트 앱**을 안내한다. 권한이 보이지 않으면 앱 유형과 전환 가능 여부부터 확인한다.
4. 사업자는 사업자 정보를 등록해 Biz 앱으로 전환한다. 사업자 번호가 없는 경우에도 조건을 충족하면 개인 개발자 Biz 앱 경로를 사용할 수 있다. 오너 본인인증과 관련 약관 동의 등 콘솔 요건을 확인한다.
5. 이메일이 서비스상 필수라면 가능한 경우 **카카오계정으로 수집 후 제공**을 검토한다. 그래도 누락/취소 응답은 처리해야 한다.

일반 카카오 로그인에 이메일을 요청한다는 이유만으로 Kakao Sync 간편가입 전체를 도입할 필요는 없다. 이메일 권한은 [동의항목 권한 표](https://developers.kakao.com/docs/ko/kakaologin/utilize), 전환 경로는 [비즈 앱/개인 개발자 안내](https://developers.kakao.com/docs/ko/app-setting/app)를 따른다.

### 6.4 테스트, 추가 동의와 운영 전환

1. Biz 앱에서 테스트 앱을 만든다면 **앱 > 일반 > 테스트 앱**을 사용하고 테스트 계정을 멤버로 추가한다. 테스트 앱은 멤버만 사용할 수 있으며 운영 키로 쓰면 안 된다.
2. 테스트 앱의 callback, REST 키와 secret을 개발 Auth에 설정한다. 원본 앱의 설정과 자동으로 같을 것이라고 가정하지 않는다.
3. `email_needs_agreement=true`이면 이메일 제공을 위한 추가 동의가 가능하다는 뜻이다. 이메일 인증 완료나 정보 존재를 뜻하지 않는다.
4. 추가 동의 후에는 새 인가 코드로 받은 token으로 사용자 정보를 다시 확인한다. 필수 동의여도 카카오계정에 정보가 없으면 이메일이 없을 수 있다.
5. 운영 앱의 이메일 권한과 동의 화면을 별도로 확인한다. 추가 권한 심사가 필요하면 실제 사용 목적과 요청 자료를 제출한다. 테스트 앱의 권한이 운영 앱에 그대로 부여되었다고 보지 않는다.

제한은 [Kakao 테스트 앱 안내](https://developers.kakao.com/docs/ko/app-setting/app), 동의 처리와 정보 누락은 [추가 동의 흐름](https://developers.kakao.com/docs/ko/kakaologin/utilize) 및 [로그인 FAQ](https://developers.kakao.com/docs/ko/kakaologin/faq)를 참고한다.

### 6.5 이메일 필드, OIDC와 Secret 교체

사용자 정보의 `is_email_valid`와 `is_email_verified`가 실제 boolean `true`인지 모두 확인한다. 유효하지 않은 이메일은 마스킹될 수 있으므로 인증 대상 주소로 그대로 사용하지 않는다. 정보가 부족하면 사용자가 직접 입력한 사용 가능한 이메일에 자체 OTP를 보낸다. 정의와 위험은 [REST API 필드](https://developers.kakao.com/docs/ko/kakaologin/rest-api)와 [이메일 사용 주의 사항](https://developers.kakao.com/docs/ko/kakaologin/common)에 따른다.

OIDC를 사용하는 구현이라면 **카카오 로그인 > OpenID Connect**를 켠다. 명시적으로 `scope`를 보낼 때는 `openid`도 필요하다. OIDC 활성화만으로 이메일이 항상 ID 토큰에 담기거나 자체 OTP가 생략되지는 않는다. 이 문서는 OIDC 전환용 새 env를 정의하지 않는다. [OIDC 설정](https://developers.kakao.com/docs/ko/kakaologin/prerequisite)과 [scope 동작](https://developers.kakao.com/docs/ko/kakaologin/utilize)을 참고한다.

Secret 재발급은 사용 중인 REST 키 아래에서 진행한다. 이전 코드를 쓰는 token 요청이 실패할 수 있어 Auth 재배포와 교체 시점을 맞춘다. 콘솔 절차가 일시 비활성화를 포함하더라도 기본 운영 설정은 활성화로 복원한다. 다른 제공자의 중복 유효 기간을 Kakao에도 가정하지 않는다. [Kakao 키 교체 안내](https://developers.kakao.com/docs/ko/app-setting/app)를 따른다.

## 7. Naver 등록 절차

### 7.1 네이버 계정과 개발자센터 등록

1. 네이버 계정이 없다면 네이버 로그인 화면의 회원가입으로 계정을 만든다. 조직 서비스는 가능하면 운영 주체의 단체 계정을 사용한다.
2. [Naver Developers](https://developers.naver.com/)에 로그인하고 Application의 애플리케이션 등록으로 이동한다.
3. 처음 이용한다면 약관 동의, 담당자 연락처 확인과 요구되는 계정 정보 등록을 완료한다.
4. 외부 대행사나 퇴사 예정 담당자만 소유권을 갖지 않게 한다. 운영 담당자 변경에 대비해 등록 계정 접근권과 연락처를 관리한다.

계정/앱 등록의 공식 절차와 단체 계정 권장은 [사전 준비 사항](https://developers.naver.com/docs/common/openapiguide/appregister.md)을 참고한다.

### 7.2 앱 생성, 웹 환경과 이메일 권한

1. 중앙 Auth를 알아볼 수 있는 앱 이름을 입력하고 사용 API에 **네이버 로그인**을 선택한다.
2. PC 웹/모바일 웹 등 실제 웹 환경을 추가한다. 네이티브 앱에서 브라우저를 열더라도 제공자 연동은 중앙 Auth의 웹 환경이다.
3. 서비스 URL에 실제 중앙 Auth 서비스의 대표 URL을 입력한다. Callback URL에는 해당 환경의 `/oauth/social/naver/callback` 전체 URL을 등록한다. 웹 환경의 callback은 최대 5개까지 추가할 수 있다.
4. 사용자가 동의 화면에서 식별할 이름과 로고를 설정한다. 네이버 자체 서비스처럼 보이는 이름/로고를 사용하지 않는다.
5. API 설정에서 실제로 사용할 이메일 등 프로필 항목만 요청한다. 휴대전화번호, 성별, 연령대 등을 불필요하게 추가하지 않는다.

등록 필드는 [Naver 앱 등록 가이드](https://developers.naver.com/docs/common/openapiguide/appregister.md), 브랜딩과 최소 수집 기준은 [Naver 사전 검수 기준](https://developers.naver.com/docs/login/verify/verify.md)을 참고한다. 서비스 URL의 도메인 처리 규칙과 callback 전체 URL 검증을 혼동하지 않는다.

### 7.3 Client ID/Secret과 개발 중 테스트

1. **Application > 내 애플리케이션**에서 방금 만든 앱을 선택한다.
2. 개요/API 설정에서 Client ID와 Client Secret을 확인해 각각 `SOCIAL_NAVER_CLIENT_ID`, `SOCIAL_NAVER_CLIENT_SECRET`에 설정한다.
3. 개발 중에는 앱 등록자 계정으로 테스트할 수 있다. 다른 계정은 **멤버관리**에서 관리자 또는 테스터로 등록한 뒤 사용한다.
4. 등록하지 않은 일반 계정은 검수 전 로그인 대상이 아니다. callback이나 코드 오류로 오인해 공개 범위를 임의로 넓히지 않는다.
5. 로컬 callback을 정확히 등록한 뒤 실제 Auth 로그인 화면에서 시작한다. callback URL을 주소창에서 직접 여는 것은 정상 로그인 테스트가 아니다.

발급값은 [Naver 개발 가이드 §3.4](https://developers.naver.com/docs/login/devguide/devguide.md), 테스트 계정 제한은 [검수 가이드의 멤버관리/테스트 절차](https://developers.naver.com/docs/login/verify/verify.md)를 따른다.

### 7.4 검수 자료와 선택 ID/PW 설명

1. 일반 계정에 공개하기 전, 앱의 **네이버 로그인 검수 상태**에서 사전 검수를 신청한다.
2. 네이버 로그인 버튼부터 동의, 필요한 이메일 OTP, 신규 가입, 로그인 완료까지 전체 화면을 순서대로 캡처한다.
3. 이메일 조회 권한을 요청했다면 계정 정보 화면 등 실제 활용처를 보여 준다. 요청해 놓고 사용하지 않는 항목은 제거한다.
4. **별도 서비스 비밀번호를 필수로 요구하지 않는다.** 이 서비스에서는 선택 ID를 비운 채 비밀번호/확인도 입력하지 않고 완료하는 경로가 있어야 한다.
5. 선택 ID를 입력했을 때만 비밀번호/확인이 나타나는 경로도 설명한다. "ID/PW 추가는 선택이며 건너뛸 수 있음"을 자료에 명확히 기재하고, 완전히 건너뛰어 가입되는 화면을 함께 제출한다.
6. 이메일 OTP는 Naver 계정의 비밀번호 재수집이 아니라 서비스 이메일 소유 확인임을 구분해 설명한다. 제공자 비밀번호는 중앙 Auth에서 받지 않는다.
7. 서비스 설명, 요청한 프로필 항목의 목적, 접근 가능한 검토 자료와 추가 업종 자료를 제출한다. 반려 시 사유를 반영해 재신청한다.

Naver는 신규 가입 시 별도 비밀번호 요구를 금지하며 전체 가입 UX를 검토한다. 선택 기능이라는 설명만으로 검수 통과가 보장되지는 않는다. 최종 검수 판단에 따르며, 위 안내를 별도 비밀번호를 필수화해도 된다는 예외로 해석하지 않는다. [현재 검수 기준](https://developers.naver.com/docs/login/verify/verify.md)과 [네이버 로그인 특약](https://developers.naver.com/products/terms/)을 확인한다.

### 7.5 이메일 누락과 현재 OIDC/PKCE

프로필 표의 이메일 필수 표기만 보고 항상 값이 있다고 가정하지 않는다. 개발 가이드는 식별자를 제외한 정보가 사용자 선택에 따라 누락될 수 있다고 설명한다. 이메일은 외부 주소로 변경될 수 있고, 프로필에는 `email_verified`가 없다. 이 서비스는 Naver 이메일 신뢰를 기본 `false`로 처리해 자체 OTP를 거친다. [프로필 명세](https://developers.naver.com/docs/login/profile/profile.md)와 [선택적 정보 제공 안내](https://developers.naver.com/docs/login/devguide/devguide.md)를 참고한다.

2026-11-04 기준 공식 가이드는 OIDC와 **S256 PKCE**도 제공한다. 기존 OAuth와 경로를 구분해야 한다.

| 방식 | 인가 endpoint | token endpoint |
| --- | --- | --- |
| 기존 OAuth 2.0 | `https://nid.naver.com/oauth2.0/authorize` | `https://nid.naver.com/oauth2.0/token` |
| OIDC | `https://nid.naver.com/oauth2/authorize` | `https://nid.naver.com/oauth2/token` |

OIDC는 `openid`, `nonce`, `code_challenge`/`code_verifier`와 S256을 지원한다. ID 토큰은 서명, `iss`, `aud`, `exp`, 요청 nonce를 검증해야 하며 이메일은 담기지 않는다. 프로필 조회가 별도로 필요하고 OIDC를 켰다고 이메일 OTP를 생략할 수 없다. 실제 Auth 어댑터가 선택한 방식과 endpoint를 일치시키며, 콘솔 작업만으로 구현을 OIDC로 전환하거나 기존 OAuth endpoint의 PKCE 지원을 가정하지 않는다. [공식 OIDC 절차 §3.5](https://developers.naver.com/docs/login/devguide/devguide.md), [현재 discovery](https://nid.naver.com/.well-known/openid-configuration)를 참고한다.

### 7.6 Secret 재발급과 이전 값의 만료

Client ID는 그대로 두고 Secret을 교체한다. **2026-08-26부터는 재발급 직전 Secret과 신규 Secret을 30일 동안 함께 사용할 수 있다.** 이전 Secret은 이 기간 내에 모든 Auth 인스턴스에서 제거해야 한다. 전체 Secret이 발급 후 30일마다 만료된다는 뜻은 아니다.

유출 사고라면 재발급만으로 이전 값이 즉시 무효화되었다고 보지 않는다. 즉시 삭제가 필요한 경우 공식 공지의 개발자센터 연락 경로를 이용한다. [Naver Secret 재발급 정책 공지](https://developers.naver.com/notice/article/33626)를 기준으로 운영한다.

## 8. 배포와 migration

### 8.0 연동 서비스 배포 순서

`chat-api-nest` 호환 업데이트를 먼저 배포하고, Todo의 directory 변환 보정도 반영한 뒤
Auth를 배포한다. Chat 기동 DDL은 실제 로컬 ID의 unique 제약을 유지하면서 cache
`login_id`에 NULL을 허용한다. 이때 테이블 잠금이 있을 수 있으므로 Chat DB도 백업한다.

소셜 전용 계정의 Auth directory `loginId`는 NULL이다. Token의 `preferred_username`은
표시용 `loginId ?? email` 문자열이며, 실제 로컬 ID 여부는
`https://lafamila.xyz/claims/local_login_id`의 `string | null`로 구분한다.
이 표시 alias를 로그인 자격 증명이나 unique 계정 키로 사용하면 안 된다.

### 8.1 배포 전 준비

1. 각 제공자의 운영 앱/client, callback, 동의 항목과 검수 상태를 확정한다. 키 발급과 공개 승인 완료 여부를 따로 기록한다.
2. 운영 Auth DB의 정상 백업과 복구 절차를 확인한다. 로컬/테스트 DB에서 먼저 migration 호환성을 검증한다.
3. 배포할 소셜 로그인 버전에 다음 migration **둘 다** 포함되었는지 확인한다. 문서에 이름이 있다는 것만으로 파일 포함/실행을 대신하지 않는다.

| Migration 이름 | 목적 |
| --- | --- |
| `AllowSocialOnlyAccounts20261104000000` | ID/비밀번호 없는 계정 허용과 자격 증명 쌍의 일관성 |
| `AddSocialLogin20261104000001` | 소셜 identity 및 로그인 트랜잭션 저장 구조 |

4. 기존 환경 변수에 실제 제공자 키 쌍을 추가하고 `RUN_MIGRATIONS=true`를 설정한다. 기존 보안 키를 유지하고 미설정 제공자는 빈 쌍으로 둔다.
5. 운영 OTP 이메일이 실제로 도착하는지 확인한다. 로컬의 메일 로그 대체 동작을 운영 SMTP 성공으로 간주하지 않는다.
6. 이 레포의 기존 배포 절차로 빌드/재배포한다. 프런트엔드나 개별 앱에 소셜 Secret을 넣지 않는다.

롤백이 필요하면 먼저 Auth writer를 종료한다. 소셜 연결이 남아 있으면 identity migration은
되돌아가지 않으며, 소셜 전용 계정이 남아 있으면 credential NOT NULL 복원도 거부한다.
identity down은 명시적인 transaction과 테이블 배타 잠금 후 연결 유무를 다시 확인한다.
롤백을 위해 계정/연결을 삭제하거나 임의 ID·비밀번호를 만들어 넣지 않는다.

이는 레포의 배포 계약이다. secret 취급은 [Google 보관 기준](https://developers.google.com/identity/protocols/oauth2/resources/best-practices), 제공자 설정의 공개 요건은 [Kakao 설정](https://developers.kakao.com/docs/ko/kakaologin/prerequisite)과 [Naver 검수](https://developers.naver.com/docs/login/verify/verify.md)를 함께 확인한다.

### 8.2 배포 후 확인

1. Auth 시작 로그와 DB migration 이력에서 위 두 migration의 성공을 확인한다. 실패했다면 로그인 버튼이 보인다는 이유로 배포 완료로 처리하지 않는다.
2. 외부에서 `ISSUER_URL`과 HTTPS 인증서, 프록시 경로를 확인한다. `/oauth/social/.../callback`이 다른 서비스로 라우팅되면 안 된다.
3. 서비스의 기존 로그인 버튼으로 중앙 Auth에 진입하고 설정한 제공자만 활성화되는지 확인한다. 모든 키가 비어 있을 때 기존 ID/PW 로그인도 유지되어야 한다.
4. 아래의 로컬/실계정 시나리오를 운영용 테스트 계정으로 재검증한다. 등록자/테스터 계정 성공만으로 모든 사용자 공개가 확인된 것은 아니다.
5. 실패 원인과 제공자 오류 코드는 확인하되, secret, token, OTP 원문, callback의 `code`/`state`가 운영 로그나 분석 도구에 수집되지 않게 한다.

코드 교환 실패를 구분할 때는 [Google OAuth 오류](https://developers.google.com/identity/protocols/oauth2/web-server), [Kakao REST API](https://developers.kakao.com/docs/ko/kakaologin/rest-api), [Naver 로그인 API](https://developers.naver.com/docs/login/api/api.md)를 참고한다.

## 9. 로컬 및 네이티브 검증 절차

### 9.1 로컬 Auth 실행

1. 개발용 DB와 기존 필수 보안 설정을 준비한다. 실제 운영 DB 연결 문자열을 쓰지 않는다.
2. `ISSUER_URL=http://localhost:3032`, 필요한 제공자 개발 키 쌍, `RUN_MIGRATIONS=true`를 로컬 런타임 환경에 설정한다. 포트가 다르면 3.2절대로 주소를 조정한다.
3. 제공자 콘솔에 로컬 callback을 등록하고 테스트 계정 권한을 준비한다. Naver는 등록자/멤버, Kakao 테스트 앱은 멤버, Google은 해당 공개/테스트 상태를 확인한다.
4. 기존 의존성이 설치된 개발 환경에서 다음 명령으로 Auth를 시작한다. 여기서 이 명령을 실행했다고 보고하는 것이 아니다.

```bash
npm run start:dev
```

5. 시작 로그에서 migration 완료를 확인한다. 테스트 서비스의 issuer/client/callback 설정을 개발 Auth에 맞춘다.
6. 테스트 서비스의 정상 로그인 진입점으로 새 브라우저 로그인을 시작한다. callback URL만 직접 호출하거나 과거 callback URL을 재사용하지 않는다.

플랫폼별 등록 제한은 [Google 테스트/공개 설정](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), [Kakao 테스트 앱](https://developers.kakao.com/docs/ko/app-setting/app), [Naver 테스트 계정](https://developers.naver.com/docs/login/verify/verify.md)을 참고한다.

### 9.2 브라우저 기능 확인표

아래 항목은 **실행 전 체크리스트**다. 완료 표시나 성공 결과를 미리 넣지 않는다. 계정 UUID와 권한은 관리자/테스트 도구로 확인하되 개인정보나 token을 문서에 기록하지 않는다.

| 시나리오 | 확인할 결과 |
| --- | --- |
| 신규 사용자, 선택 ID 비움 | 비밀번호 입력 없이 완료, `login_id`/`password_hash` 모두 `NULL` |
| 신규 사용자, 선택 ID 입력 | 중복 확인, 비밀번호 및 확인 필요. 중복/불일치 시 가입 안 됨 |
| Google Gmail 또는 검증된 Workspace 이메일 | 2.1절 조건 충족 시 자체 OTP 생략 |
| Google 외부 이메일 | Google 검증 값이 참이어도 자체 OTP 필요 |
| Kakao strict flag 충족/미충족 | 둘 다 boolean 참일 때만 생략, 나머지는 OTP 필요 |
| Naver 이메일 수신 | 이메일 도메인과 무관하게 자체 OTP 필요 |
| 제공자 이메일 누락/마스킹 | 사용 가능한 이메일 입력 및 OTP 전에는 계정 연결 안 됨 |
| 같은 검증 이메일의 기존 계정 | 기존 UUID로 연결, 기존 ID/PW/권한 유지 |
| 여러 제공자에서 같은 검증 이메일 | 첫 연결 이후 모두 같은 중앙 UUID로 로그인 |
| 이미 연결된 identity의 이메일 변경 | subject 매핑의 원래 UUID 유지, 다른 계정으로 이동하지 않음 |
| 취소, 만료, 다른 브라우저, callback 재사용 | 계정 생성/연결/세션 성공 없이 안전하게 종료 |
| 잠금/비활성/비밀번호 재설정 요구 계정 | 기존 제한을 소셜 로그인으로 우회하지 못함 |
| 가입만 완료/서비스 최초 진입 | 가입 때 권한 선생성 없음, 정상 authorize 때 기존 lazy visitor 적용 |
| 기존 서비스 로그인 복귀 | 서비스 고유 callback/state/PKCE와 token `sub` 계약 유지 |
| 기존 ID/PW 및 관리자 로그인 | 소셜 기능으로 기존 ID/PW/관리자 OTP 계약이 바뀌지 않음 |

이 표의 기대 동작은 승인된 서비스 정책이다. 이메일 판정의 원천 필드는 [Google 검증 문서](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [Kakao 응답 필드](https://developers.kakao.com/docs/ko/kakaologin/rest-api), [Naver 프로필 명세](https://developers.naver.com/docs/login/profile/profile.md)를 따른다.

### 9.3 커스텀 네이티브 앱

1. 기존 앱 로그인 버튼에서 중앙 Auth의 웹 로그인 요청을 연다. 사용자 에이전트는 시스템 브라우저 또는 기존에 지원하는 OS 인증 세션을 사용한다.
2. 중앙 Auth 화면에서 소셜 제공자를 선택한다. Google/Kakao/Naver의 인가 코드는 항상 중앙 Auth callback으로 돌아와야 한다.
3. 소셜 로그인/필요한 OTP/가입을 마친 뒤 원래 서비스 callback 또는 앱 custom scheme/Universal Link로 돌아오는지 확인한다.
4. 앱에 전달되는 값과 서비스 세션은 기존 계약을 유지한다. 제공자 access/refresh token이나 secret이 앱에 전달되면 안 된다.
5. iOS/Android/macOS/Windows에서 실제 브라우저 복귀를 확인한다. 휴대전화 실기기에서는 접근 가능한 개발용 HTTPS Auth와 해당 callback을 사용한다.

이 기능 때문에 네이티브 제공자 SDK, Google iOS/Android client, Kakao 네이티브 키/키 해시, Naver AppScheme을 새로 붙이지 않는다. 이는 앱이 제공자와 직접 OAuth를 수행하는 구조가 아니라 **중앙 Auth가 웹 OAuth 클라이언트인 구조**이기 때문이다. 임의 내장 WebView가 Google에서 허용된다고 가정하지 않는다. [Google 사용자 에이전트 제한](https://developers.google.com/identity/protocols/oauth2/web-server)과 [안전한 브라우저 사용](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)을 참고한다.

## 10. 만료, 교체 및 장애 대응

### 개발자 API와 자동 검증

- `GET /api/social/providers`: 설정된 제공자의 `{ items: [{ key, label }] }`.
- `POST /oauth/login/social/:provider`: hosted page의 `login_transaction`과
  기존 signed Strict binding cookie로 시작한다. local ID/PW를 제공자에 보내지 않는다.
- `GET /oauth/social/:provider/callback`: 제공자의 단회 state/code 응답. 직접 호출하는 API가 아니다.
- `GET /oauth/social/signup?transaction=...`: browser-bound 가입/추가 인증 화면.
- `POST /oauth/social/email/start`: JSON `{ transaction, email }`.
- `POST /oauth/social/email/verify`: JSON `{ transaction, code }`.
- `POST /oauth/social/complete`: form `{ transaction, email, name, loginId?, password?, passwordConfirm? }`.

callback 이후의 가입/OTP 단계에서도 제공자 활성 여부와 client ID를 재검사한다.
비활성화 또는 client 교체 시 진행 중 요청은 거절하고, 동일 client의 secret만 회전한 경우는 유지한다.

가입 요청의 ID가 비어 있으면 서버에서도 local 자격 증명을 생성하지 않는다.
중복 확인 API는 기존 `POST /api/signup/check-login-id`를 사용하고, 최종 저장 시 unique
제약을 다시 확인한다. Email proof는 다른 transaction/일반 signup에서 사용할 수 없다.

자동 검증은 **반드시 격리 DB**에서 실행한다. 기존 bootstrap e2e는 fixture 계정을
생성하고 admin 상태를 변경하므로 운영 또는 실사용 DB를 연결하지 않는다.
`TEST_DATABASE_URL`은 일반 e2e, `SOCIAL_MIGRATION_DATABASE_URL`은 이름이
`auth_social_migrations_`로 시작하는 빈 migration 테스트 DB에 설정한다.
일반 e2e DB 이름에는 `test`, `e2e`, `scratch` 중 하나가 있어야 한다.
환경변수를 생략하거나 비격리 이름을 지정하면 실사용 DB로 fallback하지 않고 거부한다.

```bash
npm test -- --runInBand
TEST_DATABASE_URL="$SCRATCH_DATABASE_URL" npm run test:e2e
SOCIAL_MIGRATION_DATABASE_URL="$SCRATCH_MIGRATION_DATABASE_URL" npm run test:e2e -- --runTestsByPath test/social-migrations.e2e-spec.ts
```

`scripts/social-login-browser-smoke.cjs`는 별도의 `auth_social_browser*` DB와
`SOCIAL_BROWSER_DATABASE_URL`을 요구하는 로컬 fixture다. 실제 Nest/계정/세션/코드 교환을
사용하고 외부 제공자와 메일 전송만 test double로 대체한다. 출력되는 `/fixture/login`에서
시작하며, 검증 후 해당 프로세스만 종료한다. 이 fixture의 endpoint나 가짜 제공자 키를
운영 앱에 추가하지 않는다.

### 10.1 Secret 만료와 token 만료 구분

Client Secret, 제공자 access token, refresh token, Auth 자체 세션은 서로 다른 수명과 폐기 정책을 가진다. 모든 제공자 Secret에 공통으로 적용되는 30일/90일 만료를 가정하지 않는다. 콘솔/운영 정책에 표시된 만료일, 비활성화, 유출 알림과 연락처를 관리하고 만료 전에 교체한다.

Google의 미사용 OAuth client 6개월 정책은 client 자동 삭제에 관한 것으로 Secret 발급 후 6개월 TTL과 다르다. Testing 앱의 refresh token 수명 제한도 Secret 만료가 아니며 기본 로그인 범위에는 예외가 있다. 이 서비스의 소셜 로그인 완료를 장기 제공자 refresh token 보관에 의존시키지 않는다. [Google 미사용 client 정책](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)과 [refresh token 만료 조건](https://developers.google.com/identity/protocols/oauth2)을 참고한다.

### 10.2 공통 교체 순서

1. 제공자 앱/client ID, 키 식별 정보, 담당자와 교체 사유를 확인한다. 원문 Secret을 작업 기록에 남기지 않는다.
2. 각 제공자의 공식 절차로 **같은 앱/client의 Secret**을 교체한다. Google은 새/이전 값 병행, Kakao는 재발급에 따른 중단 가능성, Naver는 이전 값 30일 정책을 구분한다.
3. 해당 `SOCIAL_*_CLIENT_SECRET`을 중앙 Auth secret 저장소에서 바꾸고 모든 인스턴스에 재배포한다. callback과 client ID는 불필요하게 바꾸지 않는다.
4. 새 브라우저 로그인으로 서버 code exchange를 확인한다. 기존 SSO 세션이 유지되는 것만으로 새 Secret의 유효성을 입증할 수 없다.
5. 지원되는 방식으로 이전 Secret을 비활성화/삭제하고 롤아웃 완료를 확인한다. 유출 사고에는 이전 Secret의 실제 폐기까지 대응한다.
6. 앱/client 자체를 교체해야 한다면 기존 subject 매핑에 대한 영향을 먼저 검토한다. 임의 새 client로 바꾸고 이메일만으로 기존 identity가 유지된다고 가정하지 않는다.

교체 절차는 [Google Secret rotation](https://support.google.com/cloud/answer/15549257?hl=en), [Kakao Secret 재발급](https://developers.kakao.com/docs/ko/app-setting/app), [Naver 이전 Secret 유효 기간](https://developers.naver.com/notice/article/33626)에 따른다.

### 10.3 자주 확인할 장애

| 증상 | 우선 확인할 항목 |
| --- | --- |
| 소셜 제공자가 표시되지 않음 | 해당 ID/Secret 쌍과 런타임 재기동 여부, 빈 쌍의 비활성 정책 |
| callback 불일치 | 실제 `ISSUER_URL`, 포트/호스트/trailing slash, 중앙 Auth 경로 등록 여부 |
| Google `invalid_client` | 정확한 Web client의 Secret, 회전/비활성화 상태, 개발/운영 값 혼용 |
| Google 테스트 계정만 로그인 가능 | Audience, 테스트 사용자와 운영 공개 상태 |
| Kakao `KOE004` / `KOE006` | 로그인 ON 여부 / 사용 중인 REST 키 아래 redirect URI |
| Kakao token 교환 실패 | 해당 REST 키와 일치하는 Secret 및 기본 활성화 상태 |
| Kakao 이메일 없음 | 앱의 이메일 권한, 동의/수집 옵션, 실제 계정 정보 존재 여부 |
| Naver 일부 계정만 로그인 가능 | 등록자/멤버 여부와 사전 검수 승인 상태 |
| Naver 교체 후 나중에 실패 | 이전 Secret 30일 종료와 미교체 Auth 인스턴스 |
| Naver/외부 Google 이메일에 OTP 표시 | 정상 보안 정책인지 확인. 이메일 수신만으로 검증을 생략하지 않음 |
| 네이티브 앱에서만 실패 | 내장 WebView 차단, 실기기 localhost, 기존 앱/BFF 복귀 경로 |

공식 오류/설정 확인은 [Google 웹 OAuth 오류](https://developers.google.com/identity/protocols/oauth2/web-server), [Kakao 설정 가이드](https://developers.kakao.com/docs/ko/kakaologin/prerequisite), [Naver 검수/테스트 가이드](https://developers.naver.com/docs/login/verify/verify.md)를 참고한다. 이 문서 작성만으로 실제 키 발급, 검수 승인 또는 운영/네이티브 smoke test가 완료된 것은 아니다.
