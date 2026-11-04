import { describe, expect, it } from 'vitest';
import {
  base64ToBytes, bytesToBase64, decryptSyncEnvelope, encryptSyncOperations, formatHlc,
  InMemoryByoStorageAdapter, LocalFirstSyncEngine, MIN_KDF_ITERATIONS, SchemaMigrationRegistry,
  validateByoStorageConfig,
  type CrdtChangeOperation, type EncryptedSyncEnvelope, type TableSchema,
} from '../src/engine';

const password = 'correct-horse-battery-2026';
const schema: TableSchema = { tableName: 'tasks', version: 1, primaryKey: 'id', columns: [
  { name: 'id', type: 'TEXT', nullable: false },
  { name: 'title', type: 'TEXT', nullable: false, defaultValue: '' },
] };
const hlc = (wallTimeMs: number, counter = 0, nodeId = 'remote') =>
  formatHlc({ wallTimeMs, counter, nodeId });
const op = (): CrdtChangeOperation => ({ opId: 'remote-op-1', table: 'tasks', pk: '1',
  nodeId: 'remote', schemaVersion: 1, kind: 'upsert', hlc: hlc(1000),
  columns: { id: { value: '1', hlc: hlc(1000) }, title: { value: 'test', hlc: hlc(1000) } } });
const makeEnvelope = (operation = op()) => encryptSyncOperations({ envelopeId: 'env-test', nodeId: 'remote',
  table: 'tasks', schemaVersion: 1, operations: [operation], passphrase: password,
  kdfIterations: MIN_KDF_ITERATIONS });

// Build authenticated fixtures with intentionally inconsistent bounds or legacy v2 AAD.
async function rewrap(original: EncryptedSyncEnvelope, changes: Partial<EncryptedSyncEnvelope>, plaintext?: string): Promise<EncryptedSyncEnvelope> {
  const previous = await decryptSyncEnvelope(original, password);
  const next = { ...original, ...changes };
  const payload = { ...previous, protocolVersion: next.protocolVersion, minHlc: next.minHlc, maxHlc: next.maxHlc };
  const subtle = globalThis.crypto.subtle;
  const material = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt: base64ToBytes(next.kdfSaltBase64) as BufferSource,
    iterations: next.kdfIterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const aad: (string | number)[] = [next.protocolVersion, next.envelopeId, next.nodeId, next.table,
    next.schemaVersion, next.minHlc, next.maxHlc, next.operationCount];
  if (next.protocolVersion === 3) aad.push(next.createdAtIso);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: base64ToBytes(next.ivBase64) as BufferSource,
    additionalData: new TextEncoder().encode(JSON.stringify(aad)), tagLength: 128 }, key,
    new TextEncoder().encode(plaintext ?? JSON.stringify(payload)));
  return { ...next, ciphertextBase64: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function pull(envelope: EncryptedSyncEnvelope) {
  const storage = new InMemoryByoStorageAdapter();
  await storage.putEnvelope(envelope);
  const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: new SchemaMigrationRegistry(schema) });
  return { engine, storage, result: await engine.pullFromStorage(storage, password, 1000) };
}

describe('v3 envelope and endpoint validation', () => {
  it('authenticates v3 timestamps but keeps v2 timestamp compatibility', async () => {
    const v3 = await makeEnvelope();
    expect(v3.protocolVersion).toBe(3);
    await expect(decryptSyncEnvelope({ ...v3, createdAtIso: '2026-01-01T00:00:00.000Z' }, password))
      .rejects.toMatchObject({ code: 'CRYPTO_AUTHENTICATION_FAILED' });
    const v2 = await rewrap(v3, { protocolVersion: 2 });
    expect((await decryptSyncEnvelope({ ...v2, createdAtIso: 'untrusted' }, password)).protocolVersion).toBe(2);
  });

  it('quarantines an authenticated non-canonical v3 timestamp', async () => {
    const env = await rewrap(await makeEnvelope(), { createdAtIso: '2026-01-01T00:00:00Z' });
    await expect(decryptSyncEnvelope(env, password)).rejects.toMatchObject({ code: 'INVALID_ENVELOPE_TIMESTAMP' });
    const { engine, storage, result } = await pull(env);
    expect(result.rejectedEnvelopes).toEqual([{ envelopeId: env.envelopeId, errorCode: 'INVALID_ENVELOPE_TIMESTAMP' }]);
    expect((await engine.pullFromStorage(storage, password, 1000)).rejectedEnvelopes).toEqual([]);
  });

  it('quarantines invalid JSON only after authentication succeeds', async () => {
    const env = await rewrap(await makeEnvelope(), {}, '{invalid json');
    const { engine, storage, result } = await pull(env);
    expect(result.rejectedEnvelopes[0]?.errorCode).toBe('MALFORMED_JSON');
    expect((await engine.pullFromStorage(storage, password, 1000)).rejectedEnvelopes).toHaveLength(0);
  });

  it.each([
    [{ minHlc: hlc(1001), maxHlc: hlc(1000) }, 'INVALID_HLC_BOUNDS'],
    [{ minHlc: hlc(1001), maxHlc: hlc(1001) }, 'HLC_BELOW_ENVELOPE_MIN'],
    [{ minHlc: hlc(999), maxHlc: hlc(1000) }, 'INVALID_HLC_BOUNDS'],
  ] as const)('rejects authenticated invalid operation bounds', async (changes, code) => {
    const env = await rewrap(await makeEnvelope(), changes);
    const { engine, storage, result } = await pull(env);
    expect(result.rejectedEnvelopes[0]?.errorCode).toBe(code);
    expect(engine.getRow('1')).toBeNull();
    expect((await engine.pullFromStorage(storage, password, 1000)).rejectedEnvelopes).toHaveLength(0);
    engine.retryRejectedEnvelopes(env.envelopeId);
    expect((await engine.pullFromStorage(storage, password, 1000)).rejectedEnvelopes).toHaveLength(1);
  });

  it('accepts a cell older than the envelope minimum', async () => {
    const operation = op();
    operation.columns.title = { value: 'old', hlc: hlc(0, 0, 'schema-default') };
    const { engine, result } = await pull(await makeEnvelope(operation));
    expect(result.rejectedEnvelopes).toHaveLength(0);
    expect(engine.getRow('1')?.title).toBe('old');
  });

  it.each([
    [{ ...op(), nodeId: 'other' }, 'HLC_NODE_MISMATCH'],
    [{ ...op(), nodeId: 'bad id' }, 'INVALID_NODE_ID'],
    [{ ...op(), table: 'other' }, 'TABLE_MISMATCH'],
    [{ ...op(), unmappedFields: { future: { value: 1, hlc: hlc(1000), sourceVersion: 0 } } }, 'INVALID_SYNC_OPERATION'],
  ] as const)('rejects malformed authenticated operation metadata', async (operation, code) => {
    const { result } = await pull(await makeEnvelope(operation));
    expect(result.rejectedEnvelopes[0]?.errorCode).toBe(code);
  });

  it.each([
    [{ value: 'bad version', hlc: hlc(1000), sourceVersion: -1 }, 'INVALID_SYNC_OPERATION'],
    [{ value: 'future clock', hlc: hlc(1001), sourceVersion: 2 }, 'HLC_EXCEEDS_OPERATION'],
    [{ value: 'excess drift', hlc: hlc(1000 + 3_600_001), sourceVersion: 2 }, 'HLC_CLOCK_DRIFT_EXCEEDED'],
    [{ value: 'nested', hlc: hlc(1000), sourceVersion: 2, alternatives: [] }, 'INVALID_SYNC_OPERATION'],
  ] as const)('validates alternative vault entry provenance and timestamps', async (alternative, code) => {
    const operation: CrdtChangeOperation = { ...op(), unmappedFields: {
      future: { value: 'ok', hlc: hlc(1000), sourceVersion: 2, alternatives: [alternative] },
    } };
    const { result } = await pull(await makeEnvelope(operation));
    expect(result.rejectedEnvelopes[0]?.errorCode).toBe(code);
  });

  it('orders valid HLCs numerically and safely leaves invalid headers last', async () => {
    const storage = new InMemoryByoStorageAdapter();
    const base = await makeEnvelope();
    await storage.putEnvelope({ ...base, envelopeId: 'a', minHlc: '000000000001000:000B:remote' });
    await storage.putEnvelope({ ...base, envelopeId: 'b', minHlc: '000000000001000:000a:remote' });
    await storage.putEnvelope({ ...base, envelopeId: 'bad', minHlc: 'invalid' });
    expect(await storage.listEnvelopeIds('tasks')).toEqual(['b', 'a', 'bad']);
  });

  it.each([
    'https://[::127.0.0.1]', 'https://[64:ff9b::8.8.8.8]', 'https://[2002::1]',
    'https://[2001:0::1]', 'https://[ff00::]', 'https://[ff02::1]', 'https://[ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]', 'https://192.0.0.1', 'https://198.18.0.1',
    'https://198.19.255.255', 'https://224.0.0.1', 'https://240.0.0.1',
  ])('blocks special-use or transition literal %s', endpointUrl => {
    expect(() => validateByoStorageConfig({ provider: 's3-compatible', bucketOrFolderName: 'bucket', endpointUrl }))
      .toThrowError(/restricted/);
  });

  it.each(['https://8.8.8.8', 'https://192.0.1.1', 'https://198.17.255.255', 'https://[2606:4700:4700::1111]'])
  ('permits public boundary literal %s', endpointUrl => {
    expect(() => validateByoStorageConfig({ provider: 's3-compatible', bucketOrFolderName: 'bucket', endpointUrl })).not.toThrow();
  });
});
