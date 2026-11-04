import { describe, expect, it } from 'vitest';
import {
  base64ToBytes, bytesToBase64, CrdtTableStore, decryptSyncEnvelope, encryptSyncOperations,
  formatHlc, InMemoryByoStorageAdapter, isRowTombstoned, LocalFirstSyncEngine,
  MAX_PAYLOAD_BYTES, MAX_STRING_CELL_LENGTH, MIN_KDF_ITERATIONS, SchemaMigrationRegistry,
  type CrdtChangeOperation, type EncryptedSyncEnvelope, type SyncPlaintextPayload,
  type TableSchema, type UnmappedVaultEntry,
} from '../src/engine';

const password = 'sync-boundary-regression-password';
const schema: TableSchema = { tableName: 'tasks', version: 1, primaryKey: 'id', columns: [
  { name: 'id', type: 'TEXT', nullable: false },
  { name: 'title', type: 'TEXT', nullable: false, defaultValue: '' },
] };
const time = (wallTimeMs: number) => formatHlc({ wallTimeMs, counter: 0, nodeId: 'remote' });
const operation = (pk: string, wallTimeMs = 1000): CrdtChangeOperation => ({
  opId: `op-${pk}`, table: 'tasks', pk, schemaVersion: 1, nodeId: 'remote', kind: 'upsert',
  hlc: time(wallTimeMs), columns: {
    id: { value: pk, hlc: time(wallTimeMs) }, title: { value: `incoming-${pk}`, hlc: time(wallTimeMs) },
  },
});
const envelope = (envelopeId: string, operations: readonly CrdtChangeOperation[]) => encryptSyncOperations({
  envelopeId, nodeId: 'remote', table: 'tasks', schemaVersion: 1, operations,
  passphrase: password, kdfIterations: MIN_KDF_ITERATIONS,
});

/** Authenticate intentionally invalid plaintext without changing the outer headers. */
async function replacePlaintext(original: EncryptedSyncEnvelope, payload: unknown): Promise<EncryptedSyncEnvelope> {
  return replacePlaintextJson(original, JSON.stringify(payload));
}

async function replacePlaintextJson(original: EncryptedSyncEnvelope, json: string): Promise<EncryptedSyncEnvelope> {
  const subtle = globalThis.crypto.subtle;
  const material = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt: base64ToBytes(original.kdfSaltBase64) as BufferSource,
    iterations: original.kdfIterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const aad = [original.protocolVersion, original.envelopeId, original.nodeId, original.table,
    original.schemaVersion, original.minHlc, original.maxHlc, original.operationCount, original.createdAtIso];
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: base64ToBytes(original.ivBase64) as BufferSource,
    additionalData: new TextEncoder().encode(JSON.stringify(aad)), tagLength: 128 }, key,
  new TextEncoder().encode(json));
  return { ...original, ciphertextBase64: bytesToBase64(new Uint8Array(ciphertext)) };
}

describe('authenticated payload consistency', () => {
  it.each([
    ['protocolVersion', 2], ['envelopeId', 'different-id'], ['nodeId', 'different-node'],
    ['table', 'different_table'], ['schemaVersion', 2], ['minHlc', time(999)], ['maxHlc', time(1001)],
    ['operations', []], ['operations', { unexpected: 'object' }],
  ] as const)('rejects authenticated inner %s mismatch and continues later work', async (field, value) => {
    const original = await envelope('bad-envelope', [operation('bad')]);
    const payload = await decryptSyncEnvelope(original, password);
    const bad = await replacePlaintext(original, { ...payload, [field]: value });
    await expect(decryptSyncEnvelope(bad, password)).rejects.toMatchObject({ code: 'ENVELOPE_HEADER_MISMATCH' });
    const storage = new InMemoryByoStorageAdapter();
    await storage.putEnvelope(bad);
    await storage.putEnvelope(await envelope('later-envelope', [operation('later', 1100)]));
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: new SchemaMigrationRegistry(schema) });
    const result = await engine.pullFromStorage(storage, password, 1200);
    expect(result.rejectedEnvelopes).toEqual([{ envelopeId: 'bad-envelope', errorCode: 'ENVELOPE_HEADER_MISMATCH' }]);
    expect(result.pulledEnvelopeIds).toEqual(['later-envelope']);
    expect(engine.getRow('bad')).toBeNull();
    expect(engine.getRow('later')?.title).toBe('incoming-later');
    expect((await engine.pullFromStorage(storage, password, 1200)).rejectedEnvelopes).toEqual([]);
  });

  it.each([
    ['null operation', null, 'INVALID_SYNC_OPERATION'],
    ['null cell', { ...operation('bad'), columns: { title: null } }, 'INVALID_SYNC_OPERATION'],
    ['object scalar', { ...operation('bad'), columns: { title: { value: {}, hlc: time(1000) } } }, 'UNSUPPORTED_SCALAR_TYPE'],
    ['wrong scalar type', { ...operation('bad'), columns: { title: { value: 42, hlc: time(1000) } } }, 'TYPE_MISMATCH'],
    ['oversized text', { ...operation('bad'), columns: { title: { value: 'a'.repeat(MAX_STRING_CELL_LENGTH + 1), hlc: time(1000) } } }, 'VALUE_TOO_LARGE'],
    ['nonfinite number', { ...operation('bad'), columns: { title: { value: 'raw-nonfinite-number', hlc: time(1000) } } }, 'NON_FINITE_NUMBER'],
    ['object tie value', { ...operation('bad'), columns: { title: { value: 'valid', tieValue: {}, hlc: time(1000) } } }, 'UNSUPPORTED_SCALAR_TYPE'],
    ['object vault scalar', { ...operation('bad'), unmappedFields: { future: { value: {}, hlc: time(1000), sourceVersion: 2 } } }, 'UNSUPPORTED_SCALAR_TYPE'],
    ['object vault tie value', { ...operation('bad'), unmappedFields: { future: { value: 'valid', tieValue: {}, hlc: time(1000), sourceVersion: 2 } } }, 'UNSUPPORTED_SCALAR_TYPE'],
    ['object vault alternative', { ...operation('bad'), unmappedFields: { future: { value: 'valid', hlc: time(1000), sourceVersion: 2,
      alternatives: [{ value: {}, hlc: time(1000), sourceVersion: 3 }] } } }, 'UNSUPPORTED_SCALAR_TYPE'],
    ['object alternative tie value', { ...operation('bad'), unmappedFields: { future: { value: 'valid', hlc: time(1000), sourceVersion: 2,
      alternatives: [{ value: 'valid', tieValue: {}, hlc: time(1000), sourceVersion: 3 }] } } }, 'UNSUPPORTED_SCALAR_TYPE'],
    ['malformed vault', { ...operation('bad'), unmappedFields: { future: { value: 'bad', hlc: time(1000), sourceVersion: 0 } } }, 'INVALID_SYNC_OPERATION'],
    ['prototype key', { ...operation('bad'), columns: JSON.parse('{"__proto__":{"value":"bad","hlc":"000000000001000:0000:remote"}}') }, 'PROTOTYPE_POLLUTION_DETECTED'],
  ] as const)('rolls back an authenticated %s after valid operations and still pushes', async (_name, malformed, code) => {
    const original = await envelope('bad-envelope', [operation('first'), operation('existing'), operation('bad')]);
    const payload = await decryptSyncEnvelope(original, password);
    const json = JSON.stringify({ ...payload, operations: [operation('first'), operation('existing'), malformed] });
    // JSON.stringify converts Infinity to null; authenticate an overflowing JSON number instead.
    const bad = await replacePlaintextJson(original, _name === 'nonfinite number'
      ? json.replace('"raw-nonfinite-number"', '1e400') : json);
    const storage = new InMemoryByoStorageAdapter();
    await storage.putEnvelope(bad);
    await storage.putEnvelope(await envelope('later-envelope', [operation('later', 1100)]));
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: new SchemaMigrationRegistry(schema) });
    engine.upsert('existing', { title: 'original' }, 900);
    const before = [...engine.getConflictLog()];
    const result = await engine.sync(storage, password, 1200, MIN_KDF_ITERATIONS);
    expect(result.rejectedEnvelopes).toEqual([{ envelopeId: 'bad-envelope', errorCode: code }]);
    expect(engine.getRow('first')).toBeNull();
    expect(engine.getRow('bad')).toBeNull();
    expect(engine.getRow('existing')?.title).toBe('original');
    expect(engine.getRow('later')?.title).toBe('incoming-later');
    expect(engine.getConflictLog()).toEqual(before);
    expect(result.appliedOperationCount).toBe(1);
    expect(result.conflictsResolved).toEqual([]);
    expect(result.pushedOperationCount).toBe(1);
    expect(engine.getPendingOutboxCount()).toBe(0);
    // Malformed authenticated payloads are quarantined, including object scalars.
    expect((await engine.pullFromStorage(storage, password, 1200)).rejectedEnvelopes).toEqual([]);
    engine.retryRejectedEnvelopes('bad-envelope');
    expect((await engine.pullFromStorage(storage, password, 1200)).rejectedEnvelopes)
      .toEqual([{ envelopeId: 'bad-envelope', errorCode: code }]);
  });
});

describe('authenticated scalar source schemas', () => {
  it('validates old values against their source type before a type-changing migration', async () => {
    const source: TableSchema = { ...schema, columns: [schema.columns[0]!,
      { name: 'title', type: 'INTEGER', nullable: false, defaultValue: 0 }] };
    const registry = new SchemaMigrationRegistry(source, [{ fromVersion: 1, toVersion: 2, description: 'format', operations: [
      { kind: 'transform_column', table: 'tasks', column: 'title', targetType: 'TEXT', fnName: 'format', transform: value => String(value) },
    ] }]);
    const op = { ...operation('old'), columns: { title: { value: 42, hlc: time(1000), tieValue: 42 } } };
    const storage = new InMemoryByoStorageAdapter();
    await storage.putEnvelope(await envelope('source-envelope', [op]));
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry });
    const result = await engine.pullFromStorage(storage, password, 1200);
    expect(result.rejectedEnvelopes).toEqual([]);
    expect(engine.getRow('old')?.title).toBe('42');
    expect(engine.listRawRowStates()[0]?.cells.title?.tieValue).toBe(42);
  });

  it.each([false, true])('preserves a changed future representation when history is known: %s', async knownHistory => {
    const steps = [{ fromVersion: 1, toVersion: 2, description: 'parse title', operations: [
      { kind: 'transform_column' as const, table: 'tasks', column: 'title', targetType: 'INTEGER' as const,
        fnName: 'parse', transform: (value: string | number | boolean | null) => Number(value) },
    ] }];
    const registry = new SchemaMigrationRegistry(schema, knownHistory ? steps : []);
    const op = { ...operation('future'), schemaVersion: 2, columns: {
      id: { value: 'future', hlc: time(1000) }, title: { value: 42, hlc: time(1000) },
    } };
    const storage = new InMemoryByoStorageAdapter();
    await storage.putEnvelope(await encryptSyncOperations({ envelopeId: 'future-envelope', nodeId: 'remote',
      table: 'tasks', schemaVersion: 2, operations: [op], passphrase: password, kdfIterations: MIN_KDF_ITERATIONS }));
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry, initialActiveVersion: 1 });
    const result = await engine.pullFromStorage(storage, password, 1200);
    expect(result.rejectedEnvelopes).toEqual([]);
    expect(engine.getRow('future')?.title).toBe('');
    expect(engine.listRawRowStates()[0]?.unmappedFields.title?.value).toBe(42);
    expect((await engine.pullFromStorage(storage, password, 1200)).rejectedEnvelopes).toEqual([]);
  });

  it('validates vault and tie values without applying the same-named current column type', async () => {
    const op = { ...operation('vault'), columns: { id: { value: 'vault', hlc: time(1000), tieValue: 3 } },
      unmappedFields: { title: { value: 42, tieValue: false, hlc: time(1000), sourceVersion: 2,
        alternatives: [{ value: true, tieValue: 7, hlc: time(1000), sourceVersion: 3 }] } } };
    const storage = new InMemoryByoStorageAdapter();
    await storage.putEnvelope(await envelope('vault-envelope', [op]));
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: new SchemaMigrationRegistry(schema) });
    expect((await engine.pullFromStorage(storage, password, 1200)).rejectedEnvelopes).toEqual([]);
    const vault = engine.listRawRowStates()[0]?.unmappedFields.title;
    expect([vault?.value, ...vault?.alternatives?.map(entry => entry.value) ?? []]).toEqual([42, true]);
    expect(engine.getRow('vault')?.title).toBe('');
  });
});

function payloadBytes(operations: readonly CrdtChangeOperation[], envelopeId = `env-${'a'.repeat(22)}`): number {
  const payload: SyncPlaintextPayload = { protocolVersion: 3, envelopeId, nodeId: 'local', table: 'tasks', schemaVersion: 1,
    minHlc: operations[0]!.hlc, maxHlc: operations[operations.length - 1]!.hlc, operations };
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

function makeByteSizedQueue(extraByte: number) {
  const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: new SchemaMigrationRegistry(schema) });
  const operations: CrdtChangeOperation[] = [];
  for (let i = 0; i < 20; i++) operations.push(engine.upsert(`large-${i}`, { title: '漢'.repeat(80000) }, 1000 + i));
  const last = engine.upsert('last', { title: '' }, 1020);
  operations.push(last);
  const paddingBytes = MAX_PAYLOAD_BYTES + extraByte - payloadBytes(operations);
  last.columns.title = { ...last.columns.title!, value: '漢'.repeat(Math.floor(paddingBytes / 3)) + 'a'.repeat(paddingBytes % 3) };
  expect(payloadBytes(operations)).toBe(MAX_PAYLOAD_BYTES + extraByte);
  return { engine, operations };
}

describe('exact UTF-8 payload limits', () => {
  it('uploads a payload exactly at the byte limit, including metadata', async () => {
    const { engine, operations } = makeByteSizedQueue(0);
    const storage = new InMemoryByoStorageAdapter();
    const uploaded = await engine.pushToStorage(storage, password, MIN_KDF_ITERATIONS);
    const payload = await decryptSyncEnvelope(uploaded!, password);
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBe(MAX_PAYLOAD_BYTES);
    expect(payload.operations).toHaveLength(operations.length);
    expect(engine.getPendingOutboxCount()).toBe(0);
  });

  it('splits a payload one byte over the limit without dropping the final operation', async () => {
    const { engine, operations } = makeByteSizedQueue(1);
    await expect(encryptSyncOperations({ envelopeId: `env-${'a'.repeat(22)}`, nodeId: 'local', table: 'tasks',
      schemaVersion: 1, operations, passphrase: password, kdfIterations: MIN_KDF_ITERATIONS }))
      .rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    const storage = new InMemoryByoStorageAdapter();
    const first = await engine.pushToStorage(storage, password, MIN_KDF_ITERATIONS);
    expect(first?.operationCount).toBe(operations.length - 1);
    expect(engine.getPendingOutboxCount()).toBe(1);
    const second = await engine.pushToStorage(storage, password, MIN_KDF_ITERATIONS);
    const batches = await Promise.all([first!, second!].map(item => decryptSyncEnvelope(item, password)));
    expect(batches.flatMap(batch => batch.operations.map(op => op.opId))).toEqual(operations.map(op => op.opId));
    for (const batch of batches) expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(engine.getPendingOutboxCount()).toBe(0);
  });
});

describe('vault-only resurrection', () => {
  it.each([
    ['older entry', { value: 'old', hlc: time(5), sourceVersion: 3 }, true],
    ['equal-clock entry', { value: 'same', hlc: time(10), sourceVersion: 3 }, true],
    ['newer entry', { value: 'new', hlc: time(20), sourceVersion: 3 }, false],
    ['one newer alternative', { value: 'old', hlc: time(5), sourceVersion: 3,
      alternatives: [{ value: 'new', hlc: time(20), sourceVersion: 3 }] }, false],
  ] as const)('handles %s in either arrival order', (_name, entry, deleted) => {
    const make = (kind: 'delete' | 'upsert'): CrdtChangeOperation => ({
      opId: kind, table: 'tasks', pk: 'row', schemaVersion: 1, nodeId: 'remote', kind,
      hlc: time(kind === 'delete' ? 10 : 30), columns: {},
      ...(kind === 'upsert' && { unmappedFields: { future: entry as UnmappedVaultEntry } }),
    });
    const states = [];
    for (const order of [['delete', 'upsert'], ['upsert', 'delete']] as const) {
      const store = new CrdtTableStore(new SchemaMigrationRegistry(schema));
      for (const kind of order) store.applyOperation(make(kind));
      const raw = store.getRawRowState('row')!;
      expect(isRowTombstoned(raw)).toBe(deleted);
      expect(store.getRow('row') === null).toBe(deleted);
      states.push(raw);
    }
    expect(states[0]).toEqual(states[1]);
  });
});
