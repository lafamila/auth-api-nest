import { Equals, IsString, MinLength, ValidateIf } from 'class-validator';

export const UNLINK_CONFIRMATION = 'UNLINK';
export const WITHDRAW_CONFIRMATION = 'DELETE';

class AccountLifecycleInput {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  currentPassword?: string;
}

export class UnlinkProviderDto extends AccountLifecycleInput {
  /** Exact, case-sensitive confirmation; no whitespace normalization. */
  @Equals(UNLINK_CONFIRMATION)
  confirmation!: string;
}

export class WithdrawAccountDto extends AccountLifecycleInput {
  /** Deletes Auth data only; other services own their separate withdrawal. */
  @Equals(WITHDRAW_CONFIRMATION)
  confirmation!: string;
}

export interface AccountLifecycleOverview {
  accountDeletion: {
    allowed: boolean;
    blockedReason: string | null;
    serviceDataPolicy: 'separate';
  };
  connections: Array<{
    provider: string;
    identityCount: number;
    canUnlink: boolean;
    reason: string | null;
    requiresProviderAuthentication: boolean;
  }>;
}

export interface UnlinkProviderResult {
  ok: true;
  reauthenticate: true;
  pendingProviderRevocations: number;
}

export interface WithdrawAccountResult {
  withdrawn: true;
  pendingProviderRevocations: number;
}
