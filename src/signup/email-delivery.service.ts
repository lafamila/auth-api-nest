import { Injectable, Logger } from '@nestjs/common';
import { Socket, connect as netConnect } from 'node:net';
import { TLSSocket, connect as tlsConnect } from 'node:tls';
import { AppConfigService } from '../config/app-config.service';

@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);

  constructor(private readonly config: AppConfigService) {}

  async sendSignupCode(email: string, code: string): Promise<void> {
    const smtp = this.config.smtp;
    if (!smtp.host) {
      this.logger.log(`Signup email verification code for ${email}: ${code}`);
      return;
    }
    await this.sendSmtp({
      host: smtp.host,
      port: smtp.port,
      user: smtp.user,
      password: smtp.password,
      from: smtp.from,
      to: email,
      subject: 'Teddy Auth email verification',
      text: `Your Teddy Auth verification code is ${code}. This code expires in 5 minutes.`,
    });
  }

  private async sendSmtp(message: {
    host: string;
    port: number;
    user: string;
    password: string;
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<void> {
    const client = await SmtpClient.connect(message.host, message.port);
    try {
      await client.expect([220]);
      await client.command(`EHLO ${message.host}`, [250]);
      if (message.port !== 465) {
        await client.command('STARTTLS', [220]);
        client.upgradeToTls(message.host);
        await client.command(`EHLO ${message.host}`, [250]);
      }
      if (message.user || message.password) {
        await client.command('AUTH LOGIN', [334]);
        await client.command(Buffer.from(message.user).toString('base64'), [334]);
        await client.command(Buffer.from(message.password).toString('base64'), [235]);
      }
      await client.command(`MAIL FROM:<${message.from}>`, [250]);
      await client.command(`RCPT TO:<${message.to}>`, [250, 251]);
      await client.command('DATA', [354]);
      await client.writeData(this.formatMessage(message));
      await client.expect([250]);
      await client.command('QUIT', [221]);
    } finally {
      client.close();
    }
  }

  private formatMessage(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): string {
    const escapeLine = (line: string) => (line.startsWith('.') ? `.${line}` : line);
    const body = message.text.split(/\r?\n/).map(escapeLine).join('\r\n');
    return [
      `From: ${message.from}`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
      '.',
      '',
    ].join('\r\n');
  }
}

class SmtpClient {
  private buffer = '';
  private waiters: Array<() => void> = [];

  private constructor(private socket: Socket | TLSSocket) {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.flushWaiters();
    });
  }

  static connect(host: string, port: number): Promise<SmtpClient> {
    return new Promise((resolve, reject) => {
      const socket =
        port === 465
          ? tlsConnect({ host, port, servername: host })
          : netConnect({ host, port });
      socket.once('connect', () => resolve(new SmtpClient(socket)));
      socket.once('secureConnect', () => resolve(new SmtpClient(socket)));
      socket.once('error', reject);
    });
  }

  upgradeToTls(host: string): void {
    this.socket.removeAllListeners('data');
    this.socket = tlsConnect({
      socket: this.socket,
      servername: host,
    });
    this.buffer = '';
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.flushWaiters();
    });
  }

  async command(command: string, expected: number[]): Promise<string> {
    this.socket.write(`${command}\r\n`);
    return this.expect(expected);
  }

  async writeData(data: string): Promise<void> {
    this.socket.write(data);
  }

  async expect(expected: number[]): Promise<string> {
    const response = await this.readResponse();
    const code = Number(response.slice(0, 3));
    if (!expected.includes(code)) {
      throw new Error(`Unexpected SMTP response: ${response.trim()}`);
    }
    return response;
  }

  close(): void {
    this.socket.end();
  }

  private readResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('SMTP response timed out'));
      }, 15000);
      const poll = () => {
        const response = this.takeCompleteResponse();
        if (response) {
          clearTimeout(timeout);
          resolve(response);
          return;
        }
        this.waiters.push(poll);
      };
      poll();
    });
  }

  private takeCompleteResponse(): string | null {
    const lines = this.buffer.split(/\r?\n/);
    if (lines.length <= 1) {
      return null;
    }
    const completeIndex = lines.findIndex((line) => /^\d{3} /.test(line));
    if (completeIndex === -1) {
      return null;
    }
    const responseLines = lines.slice(0, completeIndex + 1);
    this.buffer = lines.slice(completeIndex + 1).join('\r\n');
    return responseLines.join('\r\n');
  }

  private flushWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }
}
