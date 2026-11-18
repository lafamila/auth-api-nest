---
status: IN_PROGRESS
summary: "Auth production readiness의 repo별 실행: 공개 정책/A 로고·가입 동의·소셜 credential 분리·안전한 해제/탈퇴·철회 수신."
---

# Auth Social Production Execution

Canonical: `/Users/lafamila/work/teddy/.idea/AUTH_SOCIAL_PRODUCTION_READINESS_PLAN.md`.

전체 범위·사용자 결정·검증 gate는 root 계획을 따른다. 운영자/담당자 이경민, 문의 lafamila325@gmail.com, 한국 개인 NAS+Gmail SMTP, Auth만 탈퇴/서비스 데이터 별도 보존이 확정됐다. 카카오 전체 비활성화안은 후속 사용자 지시로 대체: 서비스 category가 game이고 현재 로그인 방식이 kakao인 경우에만 지정 문구로 차단/로그아웃한다. 연결 여부로 추정하지 않으며 공식 카카오 승인을 대체하지 않는다.
다른 repo에 대한 데이터 삭제를 임의 구현하지 않고, root orchestrator에게 영향과 follow-up을 보고한다.

## 검증 및 운영 경계

- 2026-11-18: 단위 1,333개, 격리 PostgreSQL HTTP/retention 122개, 실제 migration 95개 통과.
- TypeScript·ESLint·Prettier·보존형 Nest 빌드 통과. Desktop/mobile 브라우저의 A 로고,
  공개 footer, 키 미설정 버튼 숨김, 정책 저장과 탈퇴 모달을 확인했다.
- SSO credential-version race, 정리/재연결 race, 오래된 제공자 이벤트와 신규 연결의 race를 보강했다.
- 실사용 DB/운영 provider API/운영 배포는 미수행. 로컬 기존 watch 컨테이너 반영은 별도 사용자 응답 대기.
- Google 메일의 실제 처리 국가/보관 조건, 각 제공자 심사와 NAS backup 7일 실제 정리는 운영 후속이다.
