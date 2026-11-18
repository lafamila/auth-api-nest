# 소셜 로그인 운영 준비

확인일: 2026-11-18. 이 문서는 구현된 기능과 운영자가 별도로 수행할
심사·설정·실계정 검증을 구분한다. 코드 구현은 제공자 심사 승인이나 법률 검토의
완료를 의미하지 않는다. 기존 등록 절차는 [social-login.md](./social-login.md)를 따른다.

## 공개 사이트와 계정 기능

| 주소                                       | 동작                                                               |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `/`                                        | 미인증은 `/login`, 일반 계정은 서비스·등급, OTP 관리자 세션은 콘솔 |
| `/login`                                   | 서비스 OIDC 로그인과 같은 ID/PW·활성화된 소셜 화면                 |
| `/profile`                                 | 프로필, 로컬 ID/PW 추가, 이메일 변경, 소셜 연결·해제, Auth 탈퇴    |
| `/about`, `/terms`, `/privacy`, `/contact` | 미인증 공개; 로그인·가입·콘솔 footer에서도 접근                    |
| `/brand/auth-logo-1024.png`                | 제공자 등록용 A 로고; 128px·favicon·터치 아이콘도 제공             |
| `/admin`                                   | 제거된 UI, 404. `/api/admin/**`는 OTP 관리자 세션 필요             |

제공자 ID/Secret을 모두 비우면 해당 로그인·추가 연결·재인증 버튼은 표시하지
않는다. 실제 키가 없는 상태로 배포할 수 있다. 존재하지 않는 키나 가짜 심사 상태를
기본값으로 넣지 않는다.

소셜 신규 가입에서는 별도 ID·비밀번호를 받지 않는다. 나중에 `/profile`에서
로컬 ID/PW를 선택적으로 등록할 수 있다. 이름은 변경하지 않으며, ID/PW가 있는
계정만 새 주소의 이메일 인증 후 이메일을 바꿀 수 있다. 다른 이메일의 소셜도
명시적 계정 인증 후 연결할 수 있지만 다른 Auth 계정의 identity를 이전·병합하지 않는다.

## 동의와 개인정보

- 일반·소셜 가입은 약관과 개인정보처리방침을 각각 확인해야 완료된다.
- `GET /api/public/policies`의 `termsVersion`, `privacyVersion`, `policyDigest`와
  명시적 `termsAccepted: true`, `privacyAccepted: true`를 제출한다. 오래된 내용은 거절한다.
- 계정 생성·이메일 인증 소모·동의 저장은 하나의 트랜잭션이다. 실패 후 같은
  이메일로 재시도할 수 있다. 기존 계정의 과거 동의를 임의 생성하지 않는다.
- 기존 사용자는 `/profile`에서 현재 정책을 확인하고 제출할 수 있다.
  읽기·로그인만으로 수락 기록을 만들지 않는다.
- 공개 운영자·담당자: 이경민, 문의: lafamila325@gmail.com.
  대한민국 개인 NAS 직접 호스팅, 인증 메일은 Google Gmail SMTP다.
- `AUTH_PUBLIC_*`로 공개 정보를 관리한다. Google 메일의 처리 국가·제공자 보관기간은
  대한민국이나 특정 국가로 단정하지 않는다. 실제 계약·계정 설정을 확인하고 공개
  문구를 검토해야 한다. 약관·방침은 운영 검토용이며 법적 적합성이 보증된 문서가 아니다.

### 보관기간

| 항목                                      | 기본값·구현                                                          |
| ----------------------------------------- | -------------------------------------------------------------------- |
| 인증 거래·이메일 인증·bootstrap 임시 기록 | 최대 1시간 기준, 1분 주기 정리; 만료 토큰도 정리                     |
| 보안·접속·변경 감사로그                   | 30일 기준 자동 정리                                                  |
| 연결 중인 외부 토큰                       | 외부 연결 철회에 필요한 것만 서버 암호화 보관; 브라우저·앱 응답 제외 |
| 해제 실패 작업의 토큰 암호문              | 최대 24시간 또는 최대 시도 후 삭제, 이후 수동 해제 필요              |
| 외부 이벤트 수신함                        | 검증 후 암호화된 대상·중복 방지 이력; 실패 시 내구성 재시도          |
| DB 백업                                   | 7일 운영 기준; Auth는 백업 파일을 삭제하지 않음                      |

정리는 주기 실행되므로 경계 시점 직후까지 처리 지연이 있을 수 있다. 앱 정지·장애·
처리 적체 시 작업을 복구하고 감시해야 한다. 대기 중 외부 이벤트는 안전한 처리가
완료될 때까지 보존하며 outbound 토큰의 24시간 제한과 혼동하지 않는다.
NAS 백업 스케줄·암호화·접근권한·7일 정리는 운영자가 별도로 설정해야 한다.
이번 업데이트는 기존 백업을 삭제하지 않는다. 알림 모듈의 메시지/기기 90일,
전달 시도 30일, idempotency 7일 정책은 별도다.

## 소셜 연결 해제와 탈퇴

- `GET /api/portal/lifecycle`: 본인의 연결·해제 가능 여부와 탈퇴 범위.
- `POST /api/portal/social/:provider/unlink`:
  `{ "confirmation": "UNLINK", "currentPassword": "..." }`.
- `POST /api/portal/withdraw`:
  `{ "confirmation": "DELETE", "currentPassword": "..." }`.
- 인증 쿠키·동일 origin·`X-CSRF-Token`과 최근 인증이 필요하다.
  로컬 자격 증명이 있으면 현재 비밀번호를 검증한다. 만료된 최근 인증은 다시 로그인한다.
- 마지막 로그인 수단만 해제하는 것은 거절한다. 명시적 Auth 탈퇴는 가능하지만
  마지막 활성 superadmin을 없앨 수 없다.
- 레거시 identity에 철회용 토큰이 없으면 재인증 후 해제한다.
  `POST /api/portal/social/:provider/reconnect`는 동일 identity 재인증 URL만 돌려준다.
- DB에서 연결을 제거하고 세션을 폐기한 뒤 외부 API 해제를 내구성 작업으로 수행한다.
  외부 제공자 응답 실패를 성공으로 표시하지 않는다. 남은 작업·수동 처리 상태를 안내한다.
- Auth 탈퇴는 Auth 계정·권한·세션·소셜 연결·동의·등록 기기 등 Auth 소유 데이터만
  삭제한다. 유지되는 감사·신청 이력의 개인 식별 정보는 익명화한다.
  **Todo·Body Lab·Chat·게임 등 각 서비스의 작성 데이터는 자동 삭제하지 않는다.**
- 이미 발급된 서비스 access token은 소비 서비스의 검증/갱신까지 남을 수 있다.
  Auth 삭제만으로 모든 외부 서비스의 JWT와 데이터를 즉시 소거했다고 안내하지 않는다.

외부 토큰은 기존 `ADMIN_OTP_ENCRYPTION_KEY`로 암호화한다. 해제 대기 중 같은 identity를
다시 연결하여 새 연결이 이전 해제 작업에 의해 끊기는 경합을 방지한다. 수신 이벤트는
수신 당시 identity와 grant를 묶어 처리하므로 오래된 이벤트로 새 연결을 지우지 않는다.

## 제공자 이벤트와 수동 설정

| 제공자 | Auth 수신 주소                             | 운영 준비                                                   |
| ------ | ------------------------------------------ | ----------------------------------------------------------- |
| Naver  | `POST /oauth/events/naver`                 | 서비스 앱의 연결 해제 알림·서명/암호화 설정 확인            |
| Kakao  | `GET` 또는 form `POST /oauth/events/kakao` | 연결 끊기 알림 주소, Admin key, 숫자 app ID 설정            |
| Google | JWT `POST /oauth/events/google`            | RISC 프로젝트·서비스 계정·수신 endpoint 등록 후 명시 활성화 |

검증된 이벤트만 durable 수신함에 저장·중복 제거하고 ACK한 뒤 비동기로 반영한다.
요청 body·토큰·개인 식별자를 운영 로그에 남기지 않는다. Google은 지원하는
계정/세션 이벤트만 처리하고 알 수 없는 타입을 임의 탈퇴로 해석하지 않는다.
Google Workspace 계정에서 RISC 이벤트가 온다고 보장하지 않으며 token-specific
revocation subject 매칭도 구현 범위가 아니다. 상세 설정·제약은
[provider-events README](../src/social/provider-events/README.md)를 따른다.

## 서비스 종류와 카카오 게임 제한

`GET /api/service-categories`가 단일 목록이다:
`game`, `productivity`, `education`, `community`, `communication`, `content`,
`travel`, `health`, `finance`, `commerce`, `developer_tools`, `other`.
이는 운영용 분류이지 법적·제공자 공식 업종 분류가 아니다.

서비스 요청에서 종류를 선택하며 superadmin 콘솔에서도 종류만 수정할 수 있다.
권한·client·redirect URI 등 기존 승인 core spec은 임의 편집하지 않는다.
기존 서비스는 `other`로 이행하며 이름을 보고 자동으로 게임이라고 변경하지 않는다.
game-platform, Trip World, GB/GBA 플레이어 등은 운영자가 실제 성격을 확인하여 `game`으로 설정한다.

Auth가 서명한 ID/access token과 userinfo:

```text
https://lafamila.xyz/claims/authentication_method = local | google | kakao | naver | legacy
https://lafamila.xyz/claims/service_category = 위 category key
```

`category=game && authentication_method=kakao`일 때만 거절한다.
단순 카카오 연결 여부는 제한 근거가 아니다. 기존 provenance가 없는 게임 세션은
새 로그인으로 방법을 확정한다. 로컬 비밀번호 로그인은 기존 SSO가 카카오여도 `local`이다.

```text
카카오로 로그인한 경우 정책상 게임서비스는 이용할 수 없습니다. 다른 방식으로 로그인해주세요.
```

콜백 `error=access_denied`와 `error_code=AUTHENTICATION_METHOD_NOT_ALLOWED`,
토큰 응답의 `code=AUTHENTICATION_METHOD_NOT_ALLOWED`가 위 안내를 담는다.
출처 재인증은 `AUTHENTICATION_METHOD_REAUTHENTICATION_REQUIRED`로 구분한다.
소비 API는 검증한 claim으로 동일 제한을 적용하고 해당 세션의 쿠키·저장 세션·
realtime 연결만 정리한다. native 완료는 초기 verifier, web callback은 state를
검증한 뒤 오류를 처리한다. 실패한 새 카카오 로그인 때문에 기존의 허용된 local/Google
슬롯이나 다른 사용자 세션을 폐기하지 않는다.

서비스 분류 변경은 이미 발급한 JWT 내용을 바꾸지 않는다. 새 로그인/refresh부터
새 category를 받으며 기존 토큰에는 access-token TTL까지 지연이 있을 수 있다.
중앙 polling을 추가하지 않았고, 분류 변경을 권한 변경 이벤트로 위장하지 않는다.
이 제한 구현만으로 중앙 인증 서버 전체의 카카오 이용 승인을 보장하지 않는다.
게임·비게임 통합 인증 가능 범위는 카카오에 별도 확인한다.

## 배포 순서와 필수 환경값

1. 실제 DB 백업 후 복구 가능 여부를 확인한다. 기존 backup은 이번 작업에서 삭제하지 않는다.
2. 현재 `COOKIE_SECRET`, `ADMIN_OTP_ENCRYPTION_KEY`, `SIGNUP_EMAIL_CODE_PEPPER`를 점검한다.
   production은 sample/32자 미만 값을 거절한다. 새 설치는 `openssl rand -hex 32`로
   생성하되 **기존 암호화 키를 단순 교체하면 안 된다**. OTP·서명키·webhook·provider
   grant를 기존 키로 복호화하여 새 키로 이행하는 운영 절차가 먼저다.
3. `.env.example`의 공개 운영 정보·보관기간을 반영한다. 미사용 소셜 ID/Secret은 비운다.
   `SOCIAL_REVOCATIONS_ENABLED=true`, Kakao 알림을 쓸 경우 `SOCIAL_KAKAO_ADMIN_KEY`,
   `SOCIAL_KAKAO_APP_ID`, Google RISC는 준비 전 `SOCIAL_GOOGLE_EVENTS_ENABLED=false`.
4. 신규 4개 migration을 순서대로 적용한다:
   `AddProviderRevocations20261118000000`, `AddProviderEvents20261118000001`,
   `AddAccountPolicyConsents20261118000002`, `AddServiceCategories20261118000003`.
   기존 social·credential migrations도 선행되어야 한다. `RUN_MIGRATIONS=true` 기동으로
   적용할 수 있으며 새 schema가 없으면 readiness는 실패한다. synchronize를 운영에서 켜지 않는다.
5. Auth와 게임 소비 API/앱의 matching commit을 배포한다. 분류는 명시적으로 설정한다.
   이미 로그인한 앱의 refresh/재인증 및 서비스별 오류 표시를 검증한다.
6. 수동 provider 작업과 실계정 테스트를 수행한 뒤 버튼을 활성화한다.

## 제공자별 남은 체크리스트

**아래는 실제 수행하지 않은 운영 작업이다.**

- 공통: 운영 HTTPS·도메인 소유·공개 homepage/terms/privacy/contact, A 로고와 앱명 일치,
  현재 공개 개인정보 항목·보관기간·국외 처리 검토, 권한 최소화, 검수 계정·로그인 영상 준비.
- Naver: 운영 서비스 URL/callback 등록, 제공정보 필수·선택 항목과 실제 UI 일치,
  제공자 버튼/가입·탈퇴·연결 해제 전체 흐름 캡처, 사전 검수 신청 및 반려 항목 수정.
  소셜 가입 시 별도 비밀번호 강제 금지 여부 확인.
- Kakao: 앱/비즈니스 및 필요한 동의항목 검수, 키별 callback/Secret, 앱 아이콘·대표 URL,
  게임과 비게임 중앙 인증 정책 확인, 연결 끊기 알림 실수신 확인.
- Google: OAuth Audience/Production 전환, authorized domains와 홈페이지/방침 연결,
  실제 요청 scope 기준 브랜드 검증·필요 시 데이터 접근 검증, external 테스트 사용자 제한 해제,
  RISC 서비스 계정/endpoint 설정과 검증 이벤트 처리 확인.
- 각 제공자: 첫 가입·기존 이메일 연결·소셜 전용 ID/PW 추가·재로그인·해제·탈퇴·
  사용자 외부 철회, 서비스 OIDC 복귀와 모바일 브라우저/native 복귀까지 실계정 점검.
- NAS: backup 7일 자동 순환·암호화·접근권한·복구 테스트와 로그 비밀 마스킹 확인.

공식 근거:
[Naver 사전 검수](https://developers.naver.com/docs/login/verify/verify.md),
[Naver 검수 가이드 PDF](https://developers.naver.com/inc/devcenter/downloads/naveridro/naverlogin_solo_guide.pdf),
[Kakao 운영정책](https://developers.kakao.com/terms/ko/site-policies-20231018),
[Kakao 게임 제한 사례](https://devtalk.kakao.com/t/topic/152193),
[Kakao 통합 회원 사례](https://devtalk.kakao.com/t/topic/121671),
[Google 브랜드 검증](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification),
[Google RISC](https://developers.google.com/identity/protocols/risc).
