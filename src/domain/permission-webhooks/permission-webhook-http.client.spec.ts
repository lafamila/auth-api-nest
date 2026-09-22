import { BadRequestException } from '@nestjs/common';
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { AppConfigService } from '../../config/app-config.service';
import {
  PermissionUpdatedWebhookEvent,
  signPermissionWebhook,
} from './permission-webhook.contract';
import { PermissionWebhookHttpClient } from './permission-webhook-http.client';
import {
  parsePermissionWebhookUrl,
  resolvePermissionWebhookTarget,
} from './permission-webhook-url';

const event: PermissionUpdatedWebhookEvent = {
  id: '7754b1de-c0b9-4534-88e2-e61c6f98c26c',
  type: 'permission.updated',
  occurredAt: '2026-09-22T12:34:56.789Z',
  serviceKey: 'game-platform',
  accountId: 'f5b5fbd5-0a60-4ea5-8d49-e2d9888109dd',
  data: {
    permission: 'user',
    previousPermission: 'visitor',
    status: 'active',
    reason: 'approved',
  },
};

describe('permission webhook transport', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it('signs timestamp plus exact raw JSON with HMAC SHA256', () => {
    const rawBody = '{"id":"event-1","type":"permission.updated"}';
    expect(signPermissionWebhook('test-secret', '1700000000', rawBody)).toBe(
      'v1=a1362f9d451a176eaf4addc7c8afe32e562e0e639cad2f23647465b2bde1cba0',
    );
  });

  it('allows private HTTP only for an exact trusted origin and always blocks metadata', async () => {
    expect(() =>
      parsePermissionWebhookUrl('http://127.0.0.1:3035/events', []),
    ).toThrow(BadRequestException);
    expect(
      parsePermissionWebhookUrl('http://127.0.0.1:3035/events', [
        'http://127.0.0.1:3035',
      ]).pathname,
    ).toBe('/events');
    await expect(
      resolvePermissionWebhookTarget('http://169.254.169.254/events', [
        'http://169.254.169.254',
      ]),
    ).rejects.toThrow('forbidden address');
    expect(() =>
      parsePermissionWebhookUrl('https://example.com/events', [
        'http://*.internal:3035',
      ]),
    ).toThrow('cannot contain wildcards');
  });

  it('sends signed raw JSON and does not follow redirects', async () => {
    let redirected = false;
    const { server, origin } = await listen((request, response) => {
      if (request.url === '/redirected') {
        redirected = true;
        response.writeHead(204).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const timestamp = String(request.headers['x-auth-webhook-timestamp']);
        expect(request.headers['x-auth-webhook-id']).toBe(event.id);
        expect(request.headers['x-auth-webhook-signature']).toBe(
          signPermissionWebhook('receiver-secret', timestamp, rawBody),
        );
        expect(JSON.parse(rawBody)).toEqual(event);
        response.writeHead(302, { location: `${origin}/redirected` }).end();
      });
    });
    servers.push(server);
    const client = createClient(origin, 1000);

    await expect(
      client.post(`${origin}/events`, event, 'receiver-secret'),
    ).resolves.toEqual({ statusCode: 302, responseBody: '' });
    expect(redirected).toBe(false);
  });

  it('enforces a hard deadline against a slowly dribbling response', async () => {
    const { server, origin } = await listen((_request, response) => {
      response.writeHead(200);
      const interval = setInterval(() => response.write('.'), 15);
      response.on('close', () => clearInterval(interval));
    });
    servers.push(server);
    const client = createClient(origin, 60);

    await expect(
      client.post(`${origin}/slow`, event, 'receiver-secret'),
    ).rejects.toThrow('timed out');
  });
});

function createClient(origin: string, timeoutMs: number) {
  return new PermissionWebhookHttpClient({
    permissionWebhookRequestTimeoutMs: timeoutMs,
    permissionWebhookTrustedInternalOrigins: [origin],
  } as AppConfigService);
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://127.0.0.1:${port}` };
}
