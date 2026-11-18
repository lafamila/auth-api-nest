# 서비스 분류 계약

- `ServiceEntity`의 `SERVICE_CATEGORIES` / `SERVICE_CATEGORY_KEYS` / `ServiceCategory`가 분류의 단일 소스다. 공개 `GET /api/service-categories`는 `{ key, label }[]`를 반환하며 관리자 목록과 온보딩 builder가 함께 사용한다.
- `services.category`는 NOT NULL, 기본값 `other`이고 고정 키 CHECK 제약을 가진다. `20261118000003-AddServiceCategories.ts`는 기존 행도 모두 `other`로 유지한다. 이름이나 serviceKey로 자동 추정하지 않는다.
- 온보딩 JSON의 `category`는 선택 사항이다. 생성 시 생략하면 `other`; update 요청에서 생략하면 승인 시점의 현재 분류를 보존한다. 이전 승인 snapshot에 있던 분류를 되살리지 않는다. 명시한 `null`, 빈 문자열, 알려지지 않은 키는 거절한다.
- OTP 검증된 superadmin은 `PATCH /api/admin/services/:id`에 `{ "category": "game" }`만 보내 운영 메타데이터를 변경할 수 있다. `category` 외 필드는 403, 누락/유효하지 않은 분류는 400이다. 서비스명, serviceKey, OIDC client, scope 등 core spec의 직접 수정은 허용하지 않는다.
- 변경과 `service.category.update` 감사 기록은 같은 DB transaction에 저장한다. 감사 기록에는 관리자 ID, 이전/새 분류, IP, user-agent가 포함된다. 분류 변경만으로 permission schema version은 바꾸지 않는다.

## 기존 서비스 운영 분류

배포 후 관리자가 실제 서비스 용도를 확인하고 다음 알려진 게임 서비스들을 각각 명시적으로 `game`으로 저장한다. 마이그레이션은 이 작업을 자동 수행하지 않는다.

| serviceKey      | 확인 후 지정할 분류                                |
| --------------- | -------------------------------------------------- |
| `game-platform` | `game`                                             |
| `gbc-porting`   | `game`                                             |
| `trip-world`    | `game` (가상 여행 게임; 일반 여행 유틸리티가 아님) |

실제 카카오 로그인 방식의 게임 접근 제한은 이 모듈이 아니라 인증 흐름에서 현재 `service.category`를 읽어 적용한다. 소셜 연결 유무나 서비스명으로 로그인 방식을 추정하지 않는다.
