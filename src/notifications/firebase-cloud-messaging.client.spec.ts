import { generateKeyPairSync } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { FirebaseCloudMessagingClient } from './firebase-cloud-messaging.client';

describe('FirebaseCloudMessagingClient', () => {
  const originalFetch = global.fetch;
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString();

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends only notificationId in FCM data', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'oauth', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ name: 'projects/test/messages/1' }),
      );
    global.fetch = fetchMock as typeof fetch;

    await expect(client().send(message())).resolves.toEqual({
      status: 'delivered',
      messageId: 'projects/test/messages/1',
      code: null,
      error: null,
    });
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    if (typeof request.body !== 'string') {
      throw new Error('Expected an FCM JSON request body');
    }
    const body = JSON.parse(request.body) as {
      message: { data: Record<string, string> };
    };
    expect(body).toMatchObject({
      message: { data: { notificationId: 'notification-id' } },
    });
    expect(body.message.data).toEqual({
      notificationId: 'notification-id',
    });
  });

  it.each([
    [
      404,
      { error: { details: [{ errorCode: 'UNREGISTERED' }] } },
      'invalid_token',
    ],
    [429, { error: { status: 'RESOURCE_EXHAUSTED' } }, 'transient'],
    [503, { error: { status: 'UNAVAILABLE' } }, 'transient'],
    [400, { error: { status: 'INVALID_ARGUMENT' } }, 'terminal'],
  ] as const)(
    'classifies FCM HTTP %s as %s',
    async (status, body, expected) => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ access_token: 'oauth', expires_in: 3600 }),
        )
        .mockResolvedValueOnce(jsonResponse(body, status)) as typeof fetch;

      await expect(client().send(message())).resolves.toMatchObject({
        status: expected,
        messageId: null,
      });
    },
  );

  function client(): FirebaseCloudMessagingClient {
    return new FirebaseCloudMessagingClient({
      notificationsEnabled: true,
      firebaseProjectId: 'noti-test',
      firebaseClientEmail: 'firebase@test.example',
      firebasePrivateKey: privateKey,
    } as AppConfigService);
  }

  function message() {
    return {
      token: 'raw-fcm-token',
      title: 'Title',
      body: 'Body',
      notificationId: 'notification-id',
    };
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
});
