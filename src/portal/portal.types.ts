import { AccountEntity } from '../database/entities/account.entity';
import { TokenRecordEntity } from '../database/entities/token-record.entity';

export interface PortalActor {
  account: AccountEntity;
  session: TokenRecordEntity;
  csrfToken: string;
}

export const PORTAL_CLIENT_ID = 'auth-portal';
export const PORTAL_COOKIE = 'tas_portal_session';
export const RECENT_AUTH_MS = 15 * 60 * 1000;
