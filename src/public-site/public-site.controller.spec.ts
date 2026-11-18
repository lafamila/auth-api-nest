import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Response } from 'express';
import { isAbsolute, join } from 'node:path';
import { PublicSiteController } from './public-site.controller';
import { PublicSiteModule } from './public-site.module';
import { PublicSiteService } from './public-site.service';

const PUBLIC_DIRECTORY = join(__dirname, '..', '..', 'public');
const BRAND_ASSETS = [
  'auth-logo-1024.png',
  'auth-logo-128.png',
  'favicon-32.png',
  'apple-touch-icon.png',
];

function setup() {
  const service = new PublicSiteService({
    get: () => undefined,
  } as unknown as ConfigService);
  const set = jest.fn().mockReturnThis();
  const type = jest.fn().mockReturnThis();
  const send = jest.fn().mockReturnThis();
  const sendFile = jest.fn().mockReturnThis();
  const response = { set, type, send, sendFile } as unknown as Response;
  const controller = new PublicSiteController(service);
  return { controller, response, set, type, send, sendFile };
}

describe('PublicSiteController', () => {
  it('exports its service and resolves without database or application configuration modules', async () => {
    const module = await Test.createTestingModule({
      imports: [PublicSiteModule],
    }).compile();
    try {
      expect(module.get(PublicSiteService)).toBeInstanceOf(PublicSiteService);
      expect(module.get(PublicSiteController)).toBeInstanceOf(
        PublicSiteController,
      );
    } finally {
      await module.close();
    }
  });

  it.each(['about', 'privacy', 'terms', 'contact'] as const)(
    'serves %s without login and with strict no-store headers',
    (page) => {
      const { controller, response, set, type, send } = setup();
      controller[page](response);
      expect(type).toHaveBeenCalledWith('html');
      expect(send).toHaveBeenCalledWith(expect.stringContaining('Teddy Auth'));
      const headers = set.mock.calls[0][0] as Record<string, string>;
      expect(headers).toMatchObject({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
      });
      expect(headers['Content-Security-Policy']).toContain(
        "script-src 'self';",
      );
      expect(headers['Content-Security-Policy']).toContain(
        "style-src 'self' 'unsafe-inline';",
      );
      expect(headers['Content-Security-Policy']).toContain("img-src 'self';");
      expect(headers['Content-Security-Policy']).toContain(
        "frame-ancestors 'none';",
      );
      expect(headers['Content-Security-Policy']).toContain("base-uri 'none';");
      expect(headers['Content-Security-Policy']).not.toMatch(
        /https:|google|gstatic|unsafe-eval|script-src[^;]*unsafe-inline/,
      );
    },
  );

  it('serves only the exact stylesheet route from the project public directory', () => {
    const { controller, response, type, set, sendFile } = setup();
    controller.stylesheet(response);
    const path = sendFile.mock.calls[0][0] as string;
    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(join(PUBLIC_DIRECTORY, 'public-site.css'));
    expect(type).toHaveBeenCalledWith('text/css');
    expect(set).toHaveBeenCalledWith({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        Object.getOwnPropertyDescriptor(
          PublicSiteController.prototype,
          'stylesheet',
        )!.value,
      ),
    ).toBe('public/assets/site.css');
  });

  it.each(BRAND_ASSETS)(
    'serves allowlisted %s from an absolute, cwd-independent path',
    (asset) => {
      const { controller, response, type, sendFile } = setup();
      const cwd = jest.spyOn(process, 'cwd').mockReturnValue('/unrelated/cwd');
      try {
        controller.brand(asset, response);
        const path = sendFile.mock.calls[0][0] as string;
        expect(isAbsolute(path)).toBe(true);
        expect(path).toBe(join(PUBLIC_DIRECTORY, 'brand', asset));
        expect(type).toHaveBeenCalledWith('image/png');
      } finally {
        cwd.mockRestore();
      }
    },
  );

  it.each([
    '../signup.html',
    '..%2Fsignup.html',
    '%2e%2e%2f.env',
    'nested/auth-logo-128.png',
    'nested\\auth-logo-128.png',
    '/auth-logo-128.png',
    'auth-logo-128.png/..',
    'auth-logo-128.png\0',
    'auth-logo-128.png?x=1',
    'auth-logo-128.PNG',
    'favicon.ico',
    'public-site.css',
    '.env',
    'constructor',
    '__proto__',
    '',
  ])(
    'rejects an unlisted or traversing brand name %j before serving a file',
    (asset) => {
      const { controller, response, sendFile, set } = setup();
      expect(() => controller.brand(asset, response)).toThrow(
        NotFoundException,
      );
      expect(sendFile).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    },
  );

  it('does not shadow existing root, signup, profile, OAuth or portal routes', () => {
    const routes = Object.getOwnPropertyNames(PublicSiteController.prototype)
      .filter((method) => method !== 'constructor')
      .flatMap((method) => {
        const handler: unknown = Object.getOwnPropertyDescriptor(
          PublicSiteController.prototype,
          method,
        )?.value;
        const route: unknown =
          typeof handler === 'function'
            ? Reflect.getMetadata(PATH_METADATA, handler)
            : undefined;
        return typeof route === 'string' ? [route] : [];
      });
    expect(routes.sort()).toEqual([
      'about',
      'brand/:asset',
      'contact',
      'privacy',
      'public/assets/site.css',
      'terms',
    ]);
  });
});
