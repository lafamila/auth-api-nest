import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('signing_keys')
export class SigningKeyEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  kid!: string;

  @Column({ name: 'private_key_pem', type: 'text' })
  privateKeyPem!: string;

  @Column({ name: 'public_key_jwk', type: 'jsonb' })
  publicKeyJwk!: Record<string, unknown>;

  @Column({ default: true })
  active!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
