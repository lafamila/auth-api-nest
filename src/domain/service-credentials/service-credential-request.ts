import { Request } from 'express';
import { ServiceCredentialScope } from '../../database/entities/service-credential.entity';

export interface AuthenticatedServiceCredential {
  credentialId: string;
  keyId: string;
  serviceId: string;
  serviceKey: string;
  scopes: ServiceCredentialScope[];
}

export type ServiceCredentialRequest = Request & {
  serviceCredential?: AuthenticatedServiceCredential;
};
