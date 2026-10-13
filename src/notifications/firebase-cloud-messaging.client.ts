import { Injectable, OnModuleInit } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AppConfigService } from '../config/app-config.service';

export type FirebaseSendResult =
  | { status: 'delivered'; messageId: string | null; code: null; error: null }
  | {
      status: 'transient' | 'terminal' | 'invalid_token';
      messageId: null;
      code: string | null;
      error: string;
    };

export interface FirebaseNotificationMessage {
  token: string;
  title: string;
  body: string;
  notificationId: string;
}

@Injectable()
export class FirebaseCloudMessagingClient implements OnModuleInit {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    if (!this.config.notificationsEnabled) {
      return;
    }
    if (
      !this.config.firebaseProjectId ||
      !this.config.firebaseClientEmail ||
      !this.config.firebasePrivateKey.includes('BEGIN PRIVATE KEY')
    ) {
      throw new Error(
        'NOTIFICATIONS_ENABLED requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and a valid FIREBASE_PRIVATE_KEY',
      );
    }
  }

  async send(
    message: FirebaseNotificationMessage,
  ): Promise<FirebaseSendResult> {
    const accessToken = await this.getAccessToken();
    let response: Response;
    try {
      response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.config.firebaseProjectId)}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: message.token,
              notification: { title: message.title, body: message.body },
              data: {
                notificationId: message.notificationId,
              },
            },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      return {
        status: 'transient',
        messageId: null,
        code: 'network_error',
        error: 'FCM network request failed',
      };
    }
    const payload = await safeJson(response);
    if (response.ok) {
      return {
        status: 'delivered',
        messageId:
          typeof payload.name === 'string' ? payload.name.slice(0, 500) : null,
        code: null,
        error: null,
      };
    }
    const code = providerErrorCode(payload);
    if (code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') {
      return {
        status: 'invalid_token',
        messageId: null,
        code,
        error: 'FCM rejected the registered device token',
      };
    }
    if (response.status === 429 || response.status >= 500) {
      return {
        status: 'transient',
        messageId: null,
        code,
        error: `FCM transient HTTP ${response.status}`,
      };
    }
    return {
      status: 'terminal',
      messageId: null,
      code,
      error: `FCM terminal HTTP ${response.status}`,
    };
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      {
        iss: this.config.firebaseClientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      },
      this.config.firebasePrivateKey,
      { algorithm: 'RS256' },
    );
    let response: Response;
    try {
      response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('Firebase OAuth request failed');
    }
    const payload = await safeJson(response);
    if (!response.ok || typeof payload.access_token !== 'string') {
      throw new Error(`Firebase OAuth failed with HTTP ${response.status}`);
    }
    const expiresIn =
      typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
    this.accessToken = {
      value: payload.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return this.accessToken.value;
  }
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function providerErrorCode(payload: Record<string, unknown>): string | null {
  const error = payload.error;
  if (!error || typeof error !== 'object') {
    return null;
  }
  const details = (error as { details?: unknown }).details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (
        detail &&
        typeof detail === 'object' &&
        typeof (detail as { errorCode?: unknown }).errorCode === 'string'
      ) {
        return (detail as { errorCode: string }).errorCode.slice(0, 100);
      }
    }
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'string' ? status.slice(0, 100) : null;
}
