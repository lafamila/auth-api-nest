import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface ResolvedWebhookTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export function parsePermissionWebhookUrl(
  rawUrl: string,
  trustedInternalOrigins: string[],
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Permission webhook URL is invalid');
  }
  if (url.username || url.password || url.hash) {
    throw new BadRequestException(
      'Permission webhook URL cannot contain credentials or a fragment',
    );
  }
  const trustedOrigins = normalizeTrustedOrigins(trustedInternalOrigins);
  if (
    url.protocol !== 'https:' &&
    !(trustedOrigins.has(url.origin) && url.protocol === 'http:')
  ) {
    throw new BadRequestException(
      'Permission webhook URL must use HTTPS unless its exact origin is trusted',
    );
  }
  return url;
}

export async function resolvePermissionWebhookTarget(
  rawUrl: string,
  trustedInternalOrigins: string[],
): Promise<ResolvedWebhookTarget> {
  const url = parsePermissionWebhookUrl(rawUrl, trustedInternalOrigins);
  const trustedOrigins = normalizeTrustedOrigins(trustedInternalOrigins);
  const trustedInternal = trustedOrigins.has(url.origin);
  const hostname = stripIpv6Brackets(url.hostname);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new BadRequestException(
      'Permission webhook hostname did not resolve',
    );
  }
  for (const result of addresses) {
    const classification = classifyAddress(result.address);
    if (
      classification === 'blocked' ||
      (classification === 'private' && !trustedInternal)
    ) {
      throw new BadRequestException(
        'Permission webhook hostname resolves to a forbidden address',
      );
    }
  }
  const selected = addresses[0];
  return {
    url,
    address: selected.address,
    family: selected.family as 4 | 6,
  };
}

function classifyAddress(address: string): 'public' | 'private' | 'blocked' {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b] = ipv4;
    if (
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 192 && (b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    ) {
      return 'blocked';
    }
    if (
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      return 'private';
    }
    return 'public';
  }
  const normalized = address.toLowerCase();
  if (!normalized.includes(':')) {
    return 'blocked';
  }
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) {
    return classifyAddress(mapped);
  }
  if (
    normalized === '::' ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  ) {
    return 'blocked';
  }
  if (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd')
  ) {
    return 'private';
  }
  return 'public';
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) {
    return null;
  }
  return address.split('.').map(Number);
}

function normalizeTrustedOrigins(origins: string[]): Set<string> {
  return new Set(
    origins.map((origin) => {
      if (origin.includes('*')) {
        throw new BadRequestException(
          'Permission webhook trusted origins cannot contain wildcards',
        );
      }
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw new BadRequestException(
          'Permission webhook trusted origin is invalid',
        );
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new BadRequestException(
          'Permission webhook trusted origins must be exact HTTP(S) origins',
        );
      }
      return url.origin;
    }),
  );
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}
