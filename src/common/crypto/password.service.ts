import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  hash(value: string): Promise<string> {
    return argon2.hash(value, { type: argon2.argon2id });
  }

  verify(hash: string, value: string): Promise<boolean> {
    return argon2.verify(hash, value);
  }
}
