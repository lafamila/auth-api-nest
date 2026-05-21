import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

export interface AuthorizationCodeRecord {
  accountId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  expiresAt: Date;
}

@Injectable()
export class AuthorizationCodeService {
  private readonly codes = new Map<string, AuthorizationCodeRecord>();

  create(record: Omit<AuthorizationCodeRecord, 'expiresAt'>): string {
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      ...record,
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    return code;
  }

  consume(code: string): AuthorizationCodeRecord | null {
    const record = this.codes.get(code);
    this.codes.delete(code);
    if (!record || record.expiresAt.getTime() < Date.now()) {
      return null;
    }
    return record;
  }
}
