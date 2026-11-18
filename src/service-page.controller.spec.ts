import { UnauthorizedException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Request, Response } from 'express';
import { AdminAuthService } from './admin/admin-auth.service';
import { SERVICE_CREDENTIAL_SCOPE_DEFINITIONS } from './database/entities/service-credential.entity';
import { ServicePageController } from './service-page.controller';

describe('ServicePageController', () => {
  const protectedPages = [
    {
      method: 'service' as const,
      filename: 'service.html',
    },
    {
      method: 'serviceRequestImport' as const,
      filename: 'service-request-import.js',
    },
  ];

  function setup() {
    const validateRequest = jest.fn();
    const sendFile = jest.fn().mockReturnValue('sent');
    const adminAuth = {
      validateRequest,
    };
    const controller = new ServicePageController(
      adminAuth as unknown as AdminAuthService,
    );
    const request = { marker: Symbol('request') } as unknown as Request;
    const response = {
      sendFile,
      set: jest.fn(),
      type: jest.fn().mockReturnThis(),
      send: sendFile,
    } as unknown as Response;

    return {
      adminAuth,
      controller,
      request,
      response,
      sendFile,
      validateRequest,
    };
  }

  it.each(protectedPages)(
    'authenticates the exact request before sending $filename',
    async ({ method, filename }) => {
      const { controller, request, response, sendFile, validateRequest } =
        setup();
      validateRequest.mockResolvedValue({ id: 'admin-account' });

      await expect(controller[method](request, response)).resolves.toBe('sent');

      expect(validateRequest).toHaveBeenCalledWith(request);
      expect(sendFile).toHaveBeenCalledWith(
        method === 'service'
          ? expect.stringContaining('Create Service Onboarding Request')
          : expect.stringMatching(new RegExp(`/public/${filename}$`)),
      );
      expect(validateRequest.mock.invocationCallOrder[0]).toBeLessThan(
        sendFile.mock.invocationCallOrder[0],
      );
    },
  );

  it.each(protectedPages)(
    'returns 404 without sending $filename when authentication fails',
    async ({ method }) => {
      const { controller, request, response, sendFile, validateRequest } =
        setup();
      validateRequest.mockRejectedValue(
        new UnauthorizedException('Admin session is required'),
      );

      await expect(controller[method](request, response)).rejects.toEqual(
        expect.objectContaining({
          status: 404,
        }),
      );
      expect(sendFile).not.toHaveBeenCalled();
    },
  );

  it('does not expose the old /admin route', () => {
    const routePaths = Object.getOwnPropertyNames(
      ServicePageController.prototype,
    ).flatMap((method) => {
      const handler = Object.getOwnPropertyDescriptor(
        ServicePageController.prototype,
        method,
      )?.value as unknown;
      const path: unknown =
        typeof handler === 'function'
          ? Reflect.getMetadata(PATH_METADATA, handler)
          : undefined;
      return typeof path === 'string' ? [path] : [];
    });

    expect(routePaths).not.toContain('admin');
  });

  it('does not disguise a database failure as an anonymous 404', async () => {
    const { controller, request, response, validateRequest } = setup();
    const error = new Error('Database unavailable');
    validateRequest.mockRejectedValue(error);
    await expect(controller.service(request, response)).rejects.toBe(error);
  });

  it('keeps service credential scopes public and unchanged', () => {
    const { controller, validateRequest } = setup();

    expect(controller.serviceCredentialScopes()).toBe(
      SERVICE_CREDENTIAL_SCOPE_DEFINITIONS,
    );
    expect(validateRequest).not.toHaveBeenCalled();
  });
});
