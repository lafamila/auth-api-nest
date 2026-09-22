import { Injectable } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, RequestOptions } from 'node:https';
import { AppConfigService } from '../../config/app-config.service';
import {
  PermissionWebhookEvent,
  signPermissionWebhook,
} from './permission-webhook.contract';
import { resolvePermissionWebhookTarget } from './permission-webhook-url';

export interface PermissionWebhookHttpResult {
  statusCode: number;
  responseBody: string;
}

@Injectable()
export class PermissionWebhookHttpClient {
  constructor(private readonly config: AppConfigService) {}

  async post(
    endpointUrl: string,
    event: PermissionWebhookEvent,
    secret: string,
  ): Promise<PermissionWebhookHttpResult> {
    const controller = new AbortController();
    const timeoutMs = this.config.permissionWebhookRequestTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Permission webhook request timed out'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.postBeforeDeadline(endpointUrl, event, secret, controller.signal),
        deadline,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async postBeforeDeadline(
    endpointUrl: string,
    event: PermissionWebhookEvent,
    secret: string,
    signal: AbortSignal,
  ): Promise<PermissionWebhookHttpResult> {
    const target = await resolvePermissionWebhookTarget(
      endpointUrl,
      this.config.permissionWebhookTrustedInternalOrigins,
    );
    if (signal.aborted) {
      throw new Error('Permission webhook request timed out');
    }
    const rawBody = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const hostname = stripIpv6Brackets(target.url.hostname);
    const options: RequestOptions = {
      protocol: target.url.protocol,
      hostname: target.address,
      family: target.family,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'POST',
      servername: target.url.protocol === 'https:' ? hostname : undefined,
      signal,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(rawBody),
        host: target.url.host,
        'user-agent': 'auth-api-nest-permission-webhook/1',
        'x-auth-webhook-id': event.id,
        'x-auth-webhook-timestamp': timestamp,
        'x-auth-webhook-signature': signPermissionWebhook(
          secret,
          timestamp,
          rawBody,
        ),
      },
    };

    return new Promise((resolve, reject) => {
      const send =
        target.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = send(options, (response) => {
        const chunks: Buffer[] = [];
        let capturedBytes = 0;
        response.on('data', (chunk: Buffer | string) => {
          if (capturedBytes >= 1024) {
            return;
          }
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = 1024 - capturedBytes;
          chunks.push(buffer.subarray(0, remaining));
          capturedBytes += Math.min(buffer.length, remaining);
        });
        response.on('aborted', () =>
          reject(new Error('Permission webhook response was aborted')),
        );
        response.on('error', reject);
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            responseBody: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      request.on('error', reject);
      request.end(rawBody);
    });
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}
