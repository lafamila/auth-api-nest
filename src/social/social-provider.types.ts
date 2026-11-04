export interface SocialIdentityProfile {
  provider: string;
  providerClientId: string;
  subject: string;
  email: string | null;
  /** Authoritative email ownership proof suitable for automatic account linking. */
  emailVerified: boolean;
  name: string;
}

export interface SocialAuthorizationInput {
  state: string;
  codeChallenge: string;
}

export interface SocialCodeExchangeInput {
  code: string;
  state: string;
  codeVerifier: string;
}
