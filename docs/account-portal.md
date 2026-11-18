# Auth Account Portal

Auth 자체 사이트의 포털이며 서비스의 OIDC client 등록과 분리된다. 가짜 client/service를 seed하지 않는다.

## 화면

| 경로                                     | 동작                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `/`                                      | 미인증 → `/login`. 일반 계정은 본인 서비스/등급, superadmin은 관리 콘솔 |
| `/login`                                 | 기존 서비스 OIDC와 동일한 hosted login, ID/PW 및 설정된 소셜 제공자     |
| `/login/otp`                             | Auth 사이트 superadmin의 추가 Google OTP, 기본 인증 후에만 접근 가능    |
| `/profile`                               | 본인 정보, 이메일/PW 변경, ID/PW 등록, 소셜 추가 연결                   |
| `/service`                               | 유효한 admin session이 없으면 404                                       |
| `/admin`, `/admin/`, `/admin/index.html` | UI 제거, 404. `/api/admin/**`는 유지                                    |
| `/bootstrap`                             | 활성 superadmin이 없는 경우에만 초기 OTP 등록, 그 외 404                |

본인의 활성 서비스/assignment만 표시한다. `visitor`/`guest`와 removed permission은 제외한다.
OTP는 Auth 사이트/관리 콘솔 전용이다. 서비스의 callback/state/PKCE/nonce/UUID `sub`/권한
및 `prompt=select_account` 계약은 유지한다. 기존 유효한 OTP admin session도 루트에서 사용 가능하다.

## 계정 정책

- 이름과 기존 로그인 ID는 변경 불가.
- 실제 ID/PW가 있으면 소셜 연결/로그인 방식과 무관하게 현재 비밀번호 + 새 주소 이메일 OTP로 이메일 변경 가능.
- 소셜 전용 계정은 최근 15분 이내 본인 인증 후 ID/PW 등록 가능.
- 비밀번호 변경은 현재 비밀번호 필요. 기존 8자 이상 + 특수문자 정책 유지.
- 이메일/PW 변경 및 ID/PW 등록 후 모든 Auth portal/SSO/admin/refresh session을 폐기한다.
  이미 발급된 access token은 원래 만료까지 유효할 수 있다.
- 명시적 소셜 연결은 최근 본인 인증 + 제공자 인증을 요구하며 이메일이 달라도 허용한다.
  다른 Auth 계정에 연결된 identity는 이동/병합하지 않는다.
- `SOCIAL_{GOOGLE,KAKAO,NAVER}_CLIENT_ID`와 `_CLIENT_SECRET` 쌍이 모두 있어야
  로그인/추가 연결 버튼을 표시한다. 미설정·일부 설정은 숨긴다. 기존 연결의 상태는 읽기 전용 표시 가능.

## API

signed HttpOnly portal cookie로 본인 UUID를 결정한다. password hash, OTP secret,
provider token을 응답에 넣지 않는다. POST는 `/me`의 `csrfToken`을 `X-CSRF-Token`으로
보내야 하고 present Origin은 `ISSUER_URL` 출처와 일치해야 한다.

| 메서드/경로                                   | 요청 → 응답                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/portal/me`                          | → `{account, services, socialProviders, csrfToken}`                              |
| `POST /api/portal/email/start`                | `{email,currentPassword}` → `{verificationId,email,expiresAt}`                   |
| `POST /api/portal/email/complete`             | `{verificationId,code}` → `{reauthenticate:true}`                                |
| `POST /api/portal/password`                   | `{password,passwordConfirm,currentPassword?,loginId?}` → `{reauthenticate:true}` |
| `POST /api/portal/social/:provider/link`      | `{}` → 같은 출처의 `{redirectUrl}`                                               |
| `POST /api/portal/social/:provider/reconnect` | `{}` → 같은 identity 재인증 `{redirectUrl}`                                      |
| `GET /api/portal/lifecycle`                   | → 연결 해제·Auth 탈퇴 가능 여부                                                  |
| `POST /api/portal/social/:provider/unlink`    | `{confirmation:"UNLINK",currentPassword?}` → 해제·외부 처리 상태                 |
| `POST /api/portal/withdraw`                   | `{confirmation:"DELETE",currentPassword?}` → Auth 소유 계정 삭제                 |
| `GET /api/portal/policies`                    | → 현재 정책과 본인 확인 여부                                                     |
| `POST /api/portal/policies`                   | 현재 버전·digest와 두 명시적 동의 → 확인 이력                                    |
| `POST /api/portal/logout`                     | `{}` → `{ok:true}`                                                               |

- 세션 만료: 401 → 로그인.
- `invalid_current_password` / `invalid_email_verification`: 401이지만 필드 오류로 재시도 가능.
- `reauthentication_required`: 403 → `/login?reauth=1`, 같은 계정으로만 재인증.
- 이메일 OTP: 5분/최대 5회, 재발송 간격 60초, 기존 주소/IP 발송 제한.
- Portal: 최대 12시간. Admin: 추가로 idle 30분/absolute 12시간.
- Admin OTP challenge: 5분, browser-bound, 단회 소비, challenge당 최대 5회.
- 두 관리자 로그인 경로가 15분 단위 실패 제한을 공유한다: 계정 5회/IP 30회.
  새 portal OTP challenge 생성도 계정 10회/IP 30회로 제한한다.

## 배포

1. DB 백업 후 `AddAccountCredentialVersion20261116000000` 적용. `accounts`와
   `admin_sessions`에 기본값 0 컬럼만 추가하며 기존 계정을 재생성하지 않는다.
   TypeORM 기동 시 `RUN_MIGRATIONS=true`로 실행한다. 운영 `synchronize`는 금지한다.
2. `ISSUER_URL`은 실제 Auth URL, 기존 `COOKIE_SECRET`/`ADMIN_OTP_ENCRYPTION_KEY` 유지.
   새 필수 환경변수는 없다. 개발 compose의 `RUN_MIGRATIONS=false` 강제 여부에 주의한다.
3. Credential version 증가 후 이전 코드로 rollback하지 않는다. migration down도 버전이
   증가한 데이터가 있으면 거절한다.
4. 실제 소셜 연동/키 설정/운영 배포는 별도 작업이다. 임시 키로 버튼을 강제 노출하지 않는다.

네이버 검수 후속 작업은 [체크리스트](./naver-review-checklist.md)에 구현과 분리해 기록한다.
2026-11-18 업데이트의 추가 migration·공개 방침·개인정보 보관·탈퇴 범위는
[소셜 운영 준비](./social-production-readiness.md)를 우선 적용한다. 기존 계정의 과거 동의를 생성하지 않는다.

## 검증 범위

격리 PostgreSQL의 HTTP 회귀, 실제 migration, 데스크톱/모바일 브라우저 검증을 수행한다.
제공자 API는 mock이며 실제 Google/Kakao/Naver 승인·실연동과 운영 배포는 별도다.
기존 dependency audit의 production 경고 7건(높음 3/보통 4)은 이번 변경과 별개로 남아 있다.
Nest platform의 body-parser/multer 등 의존성 갱신은 이번 범위에서 수행하지 않았다.
