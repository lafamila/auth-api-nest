import { Injectable } from '@nestjs/common';

export interface OidcProviderAdapterRecord {
  id: string;
  payload: Record<string, unknown>;
  expiresAt?: Date;
}

@Injectable()
export class OidcProviderAdapterService {
  private readonly records = new Map<string, OidcProviderAdapterRecord>();

  async upsert(
    model: string,
    id: string,
    payload: Record<string, unknown>,
    expiresInSeconds?: number,
  ): Promise<void> {
    const expiresAt = expiresInSeconds
      ? new Date(Date.now() + expiresInSeconds * 1000)
      : undefined;
    this.records.set(`${model}:${id}`, { id, payload, expiresAt });
  }

  async find(model: string, id: string): Promise<Record<string, unknown> | undefined> {
    const record = this.records.get(`${model}:${id}`);
    if (!record) {
      return undefined;
    }
    if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
      this.records.delete(`${model}:${id}`);
      return undefined;
    }
    return record.payload;
  }

  async destroy(model: string, id: string): Promise<void> {
    this.records.delete(`${model}:${id}`);
  }
}
