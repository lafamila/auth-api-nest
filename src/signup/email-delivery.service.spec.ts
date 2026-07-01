import { EmailDeliveryService } from './email-delivery.service';

describe('EmailDeliveryService', () => {
  function serviceWithSmtp(host: string) {
    return new EmailDeliveryService({
      nodeEnv: 'development',
      smtp: {
        host,
        port: 587,
        user: 'smtp-user',
        password: 'smtp-password',
        from: 'auth@example.test',
      },
    } as never);
  }

  it('logs verification code when SMTP host is not configured', async () => {
    const service = serviceWithSmtp('');
    const sendSmtp = jest.spyOn(service as never, 'sendSmtp');

    await service.sendSignupCode('user@example.test', 'ABC123', '5 minutes');

    expect(sendSmtp).not.toHaveBeenCalled();
  });

  it('sends via SMTP when host is configured even in development', async () => {
    const service = serviceWithSmtp('smtp.example.test');
    const sendSmtp = jest
      .spyOn(service as never, 'sendSmtp')
      .mockResolvedValue(undefined as never);

    await service.sendSignupCode('user@example.test', 'ABC123', '5 minutes');

    expect(sendSmtp).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.test',
        to: 'user@example.test',
        text: expect.stringContaining('ABC123'),
        subject: '[Teddy] OAuth Email Verification',
        html: expect.stringContaining('<strong>ABC123</strong>'),
      }),
    );
  });
});
