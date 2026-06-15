import { BadRequestException } from '@nestjs/common';

export const ADMIN_TEMPORARY_RESET_PASSWORD = '123456789';

export function validateNormalPassword(password: string): void {
  if (password.length < 8) {
    throw new BadRequestException('Password must be at least 8 characters');
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    throw new BadRequestException('Password must include at least one special character');
  }
}

export function validatePasswordOrTemporaryReset(password: string): boolean {
  if (password === ADMIN_TEMPORARY_RESET_PASSWORD) {
    return true;
  }
  validateNormalPassword(password);
  return false;
}
