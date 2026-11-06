import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  decryptSyncEnvelope,
  encryptSyncOperations,
  LocalFirstSyncEngine,
  MIN_KDF_ITERATIONS,
  SchemaMigrationRegistry,
  type EncryptedSyncEnvelope,
  type TableSchema,
} from '../src/engine';

const passphrase = 'correct-horse-battery-2026';
const schema: TableSchema = {
  tableName: 'items',
  version: 1,
  primaryKey: 'id',
  columns: [
    { name: 'id', type: 'TEXT', nullable: false },
    { name: 'title', type: 'TEXT', nullable: false },
  ],
};

async function createEnvelope(): Promise<EncryptedSyncEnvelope> {
  const engine = new LocalFirstSyncEngine({
    nodeId: 'sender',
    registry: new SchemaMigrationRegistry(schema),
  });
  const operation = engine.upsert('item-1', { title: 'secret' }, 1000);
  return encryptSyncOperations({
    envelopeId: 'envelope-1',
    nodeId: 'sender',
    table: 'items',
    schemaVersion: 1,
    operations: [operation],
    passphrase,
    kdfIterations: MIN_KDF_ITERATIONS,
  });
}

function flipFirstByte(value: string): string {
  const bytes = base64ToBytes(value);
  bytes[0] = bytes[0]! ^ 1;
  return bytesToBase64(bytes);
}

describe('encrypted envelope boundary', () => {
  it.each(['ivBase64', 'kdfSaltBase64'] as const)(
    'rejects a valid-length modified %s',
    async (field) => {
      const envelope = await createEnvelope();
      expect((await decryptSyncEnvelope(envelope, passphrase)).operations).toHaveLength(1);
      const tampered = { ...envelope, [field]: flipFirstByte(envelope[field]) };
      await expect(decryptSyncEnvelope(tampered, passphrase)).rejects.toMatchObject({
        code: 'CRYPTO_AUTHENTICATION_FAILED',
      });
    }
  );

  it('rejects both modified valid and out-of-range KDF iteration counts', async () => {
    const envelope = await createEnvelope();
    await expect(
      decryptSyncEnvelope({ ...envelope, kdfIterations: MIN_KDF_ITERATIONS + 1 }, passphrase)
    ).rejects.toMatchObject({ code: 'CRYPTO_AUTHENTICATION_FAILED' });
    await expect(
      decryptSyncEnvelope({ ...envelope, kdfIterations: MIN_KDF_ITERATIONS - 1 }, passphrase)
    ).rejects.toMatchObject({ code: 'INVALID_KDF_ITERATIONS' });
  });

  it('rejects an envelope ID containing path traversal before decryption', async () => {
    const envelope = await createEnvelope();
    await expect(
      decryptSyncEnvelope({ ...envelope, envelopeId: '../outside' }, passphrase)
    ).rejects.toMatchObject({ code: 'UNSAFE_STORAGE_KEY' });
  });
});
