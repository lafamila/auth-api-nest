import {
  ServiceCredentialScope,
  ServiceCredentialStatus,
} from '../../database/entities/service-credential.entity';
import { AuthenticatedServiceCredential } from './service-credential-request';

/**
 * 검증 실패 시 호출자에게 노출하는 사유. 존재 여부·소속 서비스 같은 추가 정보가
 * 새지 않도록 이 3종만 유지한다.
 */
export type ServiceCredentialVerificationReason =
  | 'invalid_credential'
  | 'disabled'
  | 'scope_missing';

/** 감사 로그 전용 상세 사유. 응답 본문에는 절대 넣지 않는다. */
export type ServiceCredentialVerificationDetail =
  | 'ok'
  | 'not_found'
  | 'secret_mismatch'
  | 'cross_service'
  | 'status_disabled'
  | 'service_inactive'
  | 'expired'
  | 'scope_missing';

export const SERVICE_CREDENTIAL_VERIFICATION_REASON_BY_DETAIL: Record<
  Exclude<ServiceCredentialVerificationDetail, 'ok'>,
  ServiceCredentialVerificationReason
> = {
  not_found: 'invalid_credential',
  secret_mismatch: 'invalid_credential',
  cross_service: 'invalid_credential',
  status_disabled: 'disabled',
  service_inactive: 'disabled',
  expired: 'disabled',
  scope_missing: 'scope_missing',
};

export interface VerifyServiceCredentialContext {
  /** 호출자 자신의 credential (guard 가 채운 값). */
  caller: AuthenticatedServiceCredential;
  requiredScope?: ServiceCredentialScope;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type ServiceCredentialVerificationResult =
  | {
      valid: true;
      serviceKey: string;
      scopes: ServiceCredentialScope[];
      status: ServiceCredentialStatus;
    }
  | {
      valid: false;
      reason: ServiceCredentialVerificationReason;
    };
