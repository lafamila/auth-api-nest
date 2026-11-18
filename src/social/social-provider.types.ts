export interface SocialIdentityProfile {
  provider: string;
  providerClientId: string;
  subject: string;
  email: string | null;
  /** Authoritative email ownership proof suitable for automatic account linking. */
  emailVerified: boolean;
  name: string;
  /** Server-only encrypted credentials, never a browser profile field. */
  encryptedRevocationGrant?: string;
}

export interface SocialAuthorizationInput {
  state: string;
  codeChallenge: string;
  forceConsent?: boolean;
}

export interface SocialCodeExchangeInput {
  code: string;
  state: string;
  codeVerifier: string;
}
