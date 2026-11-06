import { describe, expect, it } from 'vitest';
import {
  assertValidStorageKey, decryptSyncEnvelope, encryptSyncOperations, formatHlc,
  InMemoryByoStorageAdapter, LocalFirstSyncEngine, MAX_BATCH_OPERATIONS, MAX_STRING_CELL_LENGTH,
  MIN_KDF_ITERATIONS, SchemaMigrationRegistry,
  type CrdtChangeOperation, type EncryptedSyncEnvelope, type TableSchema,
} from '../src/engine';

const schema: TableSchema = { tableName: 'tasks', version: 1, primaryKey: 'id', columns: [
  { name: 'id', type: 'TEXT', nullable: false },
  { name: 'title', type: 'TEXT', nullable: false, defaultValue: '' },
] };
const password = 'a sufficiently long passphrase';
const makeEngine = (nodeId = 'local') => new LocalFirstSyncEngine({ nodeId, registry: new SchemaMigrationRegistry(schema) });
const remoteClock = formatHlc({ wallTimeMs: 1000, counter: 0, nodeId: 'remote' });
const makeRemote = (id: string, title: string): CrdtChangeOperation => ({
  opId: id, table: 'tasks', pk: id, schemaVersion: 1, hlc: remoteClock, nodeId: 'remote', kind: 'upsert',
  columns: { id: { value: id, hlc: remoteClock }, title: { value: title, hlc: remoteClock } },
});
const makeEnvelope = (envelopeId: string, operation: CrdtChangeOperation) => encryptSyncOperations({
  envelopeId, nodeId: 'remote', table: 'tasks', schemaVersion: 1, operations: [operation],
  passphrase: password, kdfIterations: MIN_KDF_ITERATIONS,
});

describe('sync batch and storage regressions', () => {
  it('uses distinct bounded storage keys across restarts with maximal node and schema identifiers', async () => {
    const maximalSchema = { ...schema, version: Number.MAX_SAFE_INTEGER };
    const registry = new SchemaMigrationRegistry(maximalSchema);
    const storage = new InMemoryByoStorageAdapter();
    const first = new LocalFirstSyncEngine({ nodeId: 'n'.repeat(64), registry });
    const restarted = new LocalFirstSyncEngine({ nodeId: 'n'.repeat(64), registry });
    first.upsert('first', { title: 'first' }, 1000);
    restarted.upsert('second', { title: 'second' }, 2000);
    const a = await first.pushToStorage(storage, password, MIN_KDF_ITERATIONS);
    const b = await restarted.pushToStorage(storage, password, MIN_KDF_ITERATIONS);
    expect(a?.envelopeId).not.toEqual(b?.envelopeId);
    expect(assertValidStorageKey(a!.envelopeId)).toBe(a!.envelopeId);
    expect(assertValidStorageKey(b!.envelopeId)).toBe(b!.envelopeId);
    expect(storage.inspectAllEnvelopes()).toHaveLength(2);
    const peer = new LocalFirstSyncEngine({ nodeId: 'peer', registry });
    expect((await peer.pullFromStorage(storage, password, 2000)).pulledEnvelopeIds).toHaveLength(2);
    expect(peer.getRow('first')?.title).toBe('first');
    expect(peer.getRow('second')?.title).toBe('second');
  });

  it('sends a bounded prefix when the operation count exceeds the batch limit', async () => {
    const engine = makeEngine();
    const storage = new InMemoryByoStorageAdapter();
    for (let i = 0; i < MAX_BATCH_OPERATIONS + 1; i++) engine.upsert(`row-${i}`, { title: 'x' }, 1000 + i);
    const first = await engine.sync(storage, password, 10000, MIN_KDF_ITERATIONS);
    expect(first.pushedOperationCount).toBe(MAX_BATCH_OPERATIONS);
    expect(engine.getPendingOutboxCount()).toBe(1);
    const second = await engine.sync(storage, password, 10000, MIN_KDF_ITERATIONS);
    expect(second.pushedOperationCount).toBe(1);
    expect(engine.getPendingOutboxCount()).toBe(0);
    const batches = await Promise.all(storage.inspectAllEnvelopes().map(e => decryptSyncEnvelope(e, password)));
    expect(batches.flatMap(batch => batch.operations)).toHaveLength(MAX_BATCH_OPERATIONS + 1);
  });

  it('splits by actual UTF-8 payload bytes and retains excess operations', async () => {
    const engine = makeEngine();
    const storage = new InMemoryByoStorageAdapter();
    // UTF-8 bytes exceed character length and make the size limit bind first.
    const title = '漢'.repeat(MAX_STRING_CELL_LENGTH);
    for (let i = 0; i < 8; i++) engine.upsert(`large-${i}`, { title }, 1000 + i);
    const first = await engine.pushToStorage(storage, password, MIN_KDF_ITERATIONS);
    expect(first!.operationCount).toBeGreaterThan(0);
    expect(first!.operationCount).toBeLessThan(8);
    expect(engine.getPendingOutboxCount()).toBe(8 - first!.operationCount);
    const second = await engine.pushToStorage(storage, password, MIN_KDF_ITERATIONS);
    expect(first!.operationCount + second!.operationCount).toBe(8);
    expect(engine.getPendingOutboxCount()).toBe(0);
  });

  it('retains an individually oversized queued operation with a clear error', async () => {
    const engine = makeEngine();
    const operation = engine.upsert('oversize', { title: 'initial' }, 1000);
    operation.columns.title = { ...operation.columns.title!, value: 'a'.repeat(6 * 1024 * 1024) };
    await expect(engine.pushToStorage(new InMemoryByoStorageAdapter(), password, MIN_KDF_ITERATIONS))
      .rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(engine.getPendingOutboxCount()).toBe(1);
  });

  it('reports a transient read error, applies later envelopes, pushes, and retries the read', async () => {
    class FlakyStorage extends InMemoryByoStorageAdapter {
      fail = true;
      override async getEnvelope(id: string): Promise<EncryptedSyncEnvelope | null> {
        if (id === 'bad-read' && this.fail) throw new Error('transient network failure');
        return super.getEnvelope(id);
      }
    }
    const storage = new FlakyStorage();
    await storage.putEnvelope(await makeEnvelope('bad-read', makeRemote('bad', 'recovered')));
    await storage.putEnvelope(await makeEnvelope('good-read', makeRemote('good', 'applied')));
    const engine = makeEngine();
    engine.upsert('own', { title: 'queued' }, 1000);
    const result = await engine.sync(storage, password, 1000, MIN_KDF_ITERATIONS);
    expect(result.rejectedEnvelopes).toEqual([{ envelopeId: 'bad-read', errorCode: 'STORAGE_READ_FAILED' }]);
    expect(result.pulledEnvelopeIds).toContain('good-read');
    expect(result.pushedOperationCount).toBe(1);
    expect(engine.getRow('good')?.title).toBe('applied');
    storage.fail = false;
    expect((await engine.pullFromStorage(storage, password, 1000)).pulledEnvelopeIds).toContain('bad-read');
    expect(engine.getRow('bad')?.title).toBe('recovered');
  });

  it('quarantines an authenticated primary-key mismatch until explicit retry', async () => {
    const operation = makeRemote('row', 'bad');
    operation.columns.id = { value: 'other', hlc: remoteClock };
    const storage = new InMemoryByoStorageAdapter();
    await storage.putEnvelope(await encryptSyncOperations({
      envelopeId: 'mismatch', nodeId: 'remote', table: 'tasks', schemaVersion: 1,
      operations: [makeRemote('valid', 'applied first'), makeRemote('existing', 'incoming'), operation],
      passphrase: password, kdfIterations: MIN_KDF_ITERATIONS,
    }));
    const engine = makeEngine();
    engine.upsert('existing', { title: 'original' }, 900);
    const conflictsBefore = [...engine.getConflictLog()];
    const rejected = await engine.pullFromStorage(storage, password, 1000);
    expect(rejected.rejectedEnvelopes).toEqual([{ envelopeId: 'mismatch', errorCode: 'PRIMARY_KEY_MISMATCH' }]);
    expect(engine.getRow('valid')).toBeNull();
    expect(engine.getRow('row')).toBeNull();
    expect(engine.getRow('existing')?.title).toBe('original');
    expect(engine.getConflictLog()).toEqual(conflictsBefore);
    expect(rejected.conflictsResolved).toEqual([]);
    expect(rejected.appliedOperationCount).toBe(0);
    expect((await engine.pullFromStorage(storage, password, 1000)).rejectedEnvelopes).toEqual([]);
    engine.retryRejectedEnvelopes('mismatch');
    expect((await engine.pullFromStorage(storage, password, 1000)).rejectedEnvelopes).toHaveLength(1);
  });
});
