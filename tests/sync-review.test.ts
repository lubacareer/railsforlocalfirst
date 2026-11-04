import { describe, expect, it } from 'vitest';
import {
  base64ToBytes, bytesToBase64, decryptSyncEnvelope, encryptSyncOperations, formatHlc, InMemoryByoStorageAdapter,
  LocalFirstSyncEngine, MIN_KDF_ITERATIONS, SchemaMigrationRegistry,
  type CrdtChangeOperation, type EncryptedSyncEnvelope, type TableSchema,
} from '../src/engine';

const schema: TableSchema = {
  tableName: 'tasks', version: 1, primaryKey: 'id',
  columns: [{ name: 'id', type: 'TEXT', nullable: false },
    { name: 'title', type: 'TEXT', nullable: false, defaultValue: '' }],
};
const passphrase = 'correct-horse-battery-2026';
const registry = () => new SchemaMigrationRegistry(schema);
const time = (wallTimeMs: number) => formatHlc({ wallTimeMs, counter: 0, nodeId: 'remote' });
const op = (id: string, hlc: string, title: string): CrdtChangeOperation => ({
  opId: id, table: 'tasks', pk: 'one', schemaVersion: 1, hlc, nodeId: 'remote', kind: 'upsert',
  columns: { id: { value: 'one', hlc }, title: { value: title, hlc } },
});
const envelope = (id: string, operations: CrdtChangeOperation[]) => encryptSyncOperations({
  envelopeId: id, nodeId: 'remote', table: 'tasks', schemaVersion: 1, operations,
  passphrase, kdfIterations: MIN_KDF_ITERATIONS,
});

describe('sync review regressions', () => {
  it('writes v2 envelopes without plaintext hashes and rejects v1', async () => {
    const env = await envelope('env-test', [op('one', time(1000), 'secret')]);
    expect(env.protocolVersion).toBe(2);
    expect(env).not.toHaveProperty('payloadSha256');
    expect((await decryptSyncEnvelope(env, passphrase)).operations).toHaveLength(1);
    await expect(decryptSyncEnvelope({ ...env, protocolVersion: 1 } as unknown as EncryptedSyncEnvelope, passphrase))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PROTOCOL_VERSION' });
  });

  it.each(['columns', 'unmappedFields'] as const)('rejects newer %s HLCs atomically and continues with a later envelope', async (field) => {
    const store = new InMemoryByoStorageAdapter();
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry(), maxDriftMs: 1000 });
    engine.upsert('one', { title: 'local' }, 1000);
    let bad = op('bad', time(1100), 'bad');
    if (field === 'columns') bad.columns.title = { value: 'poison', hlc: time(1101) };
    else bad = { ...bad, unmappedFields: { future: { value: 'poison', hlc: time(1101), sourceVersion: 2 } } };
    const first = op('first', time(1050), 'should roll back');
    await store.putEnvelope(await envelope('env-bad', [first, bad]));
    const before = engine.getRawRowState('one');
    const result = await engine.pullFromStorage(store, passphrase, 1200);
    expect(result.rejectedEnvelopes).toEqual([{ envelopeId: 'env-bad', errorCode: 'HLC_EXCEEDS_OPERATION' }]);
    expect(result.appliedOperationCount).toBe(0);
    expect(result.conflictsResolved).toHaveLength(0);
    expect(engine.getConflictLog()).toHaveLength(0);
    expect(engine.getRawRowState('one')).toEqual(before);
    // A failed envelope did not advance the clock.
    expect(engine.upsert('clock-check', { title: 'x' }, 1000).hlc).toBe('000000000001000:0001:local');
    await store.putEnvelope(await envelope('env-good', [op('good', time(1200), 'good')]));
    const continued = await engine.pullFromStorage(store, passphrase, 1200);
    expect(continued.pulledEnvelopeIds).toContain('env-good');
    expect(engine.getRow('one')?.title).toBe('good');
  });

  it.each(['columns', 'unmappedFields'] as const)('rejects excessive drift in %s before mutation', async (field) => {
    const store = new InMemoryByoStorageAdapter();
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry(), maxDriftMs: 100 });
    let bad = op('bad', time(1000), 'bad');
    if (field === 'columns') bad.columns.title = { value: 'x', hlc: time(2000) };
    else bad = { ...bad, unmappedFields: { future: { value: 'x', hlc: time(2000), sourceVersion: 2 } } };
    await store.putEnvelope(await envelope('env-drift', [bad]));
    const result = await engine.pullFromStorage(store, passphrase, 1000);
    expect(result.rejectedEnvelopes[0]?.errorCode).toBe('HLC_CLOCK_DRIFT_EXCEEDED');
    expect(engine.getRow('one')).toBeNull();
    // Drift rejections are retried rather than quarantined.
    expect((await engine.pullFromStorage(store, passphrase, 1000)).rejectedEnvelopes).toHaveLength(1);
  });

  it('rejects an authenticated operation above the authenticated envelope maximum', async () => {
    const env = await envelope('env-max', [op('one', time(1000), 'x')]);
    const payload = await decryptSyncEnvelope(env, passphrase);
    const forged = { ...payload, operations: [op('one', time(1001), 'x')] };
    const subtle = globalThis.crypto.subtle;
    const material = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey({ name: 'PBKDF2', salt: base64ToBytes(env.kdfSaltBase64) as BufferSource,
      iterations: env.kdfIterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const aad = new TextEncoder().encode(JSON.stringify([env.protocolVersion, env.envelopeId, env.nodeId,
      env.table, env.schemaVersion, env.minHlc, env.maxHlc, env.operationCount]));
    const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv: base64ToBytes(env.ivBase64) as BufferSource,
      additionalData: aad, tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(forged)));
    const store = new InMemoryByoStorageAdapter();
    await store.putEnvelope({ ...env, ciphertextBase64: bytesToBase64(new Uint8Array(encrypted)) });
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry() });
    const result = await engine.pullFromStorage(store, passphrase, 1000);
    expect(result.rejectedEnvelopes[0]?.errorCode).toBe('HLC_EXCEEDS_ENVELOPE_MAX');
    expect(engine.getRow('one')).toBeNull();
  });

  it('quarantines authentication failures but allows explicit retry after credentials are fixed', async () => {
    const store = new InMemoryByoStorageAdapter();
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry() });
    await store.putEnvelope(await envelope('env-auth', [op('one', time(1000), 'valid')]));
    const rejected = await engine.pullFromStorage(store, 'wrong-password-value', 1000);
    expect(rejected.rejectedEnvelopes[0]?.errorCode).toBe('CRYPTO_AUTHENTICATION_FAILED');
    expect((await engine.pullFromStorage(store, passphrase, 1000)).pulledEnvelopeIds).toHaveLength(0);
    engine.retryRejectedEnvelopes('env-auth');
    expect((await engine.pullFromStorage(store, passphrase, 1000)).pulledEnvelopeIds).toEqual(['env-auth']);
  });

  it('continues sync and pushes after a tampered envelope, then retries the restored envelope', async () => {
    const store = new InMemoryByoStorageAdapter();
    const valid = await envelope('env-auth', [op('one', time(1000), 'remote')]);
    await store.putEnvelope(valid);
    store.unsafeOverwriteForTamperTest(valid.envelopeId, { ...valid, schemaVersion: 2 });
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry() });
    engine.upsert('own', { title: 'local' }, 1000);
    const result = await engine.sync(store, passphrase, 1000, MIN_KDF_ITERATIONS);
    expect(result.rejectedEnvelopes).toEqual([{ envelopeId: 'env-auth', errorCode: 'CRYPTO_AUTHENTICATION_FAILED' }]);
    expect(result.pushedOperationCount).toBe(1);
    store.unsafeOverwriteForTamperTest(valid.envelopeId, valid);
    engine.retryRejectedEnvelopes(valid.envelopeId);
    const retry = await engine.pullFromStorage(store, passphrase, 1000);
    expect(retry.pulledEnvelopeIds).toContain(valid.envelopeId);
    expect(engine.getRow('one')?.title).toBe('remote');
  });

  it.each(['ivBase64', 'kdfSaltBase64', 'kdfIterations'] as const)(
    'rejects a tampered %s and still applies another envelope and pushes', async (field) => {
      const store = new InMemoryByoStorageAdapter();
      const bad = await envelope('env-bad', [op('bad', time(1000), 'bad')]);
      const good = await envelope('env-good', [op('good', time(1001), 'good')]);
      await store.putEnvelope(bad);
      await store.putEnvelope(good);
      const tampered = { ...bad };
      if (field === 'kdfIterations') {
        Object.assign(tampered, { kdfIterations: bad.kdfIterations + 1 });
      } else {
        const bytes = base64ToBytes(bad[field]);
        bytes[0] = bytes[0]! ^ 1;
        Object.assign(tampered, { [field]: bytesToBase64(bytes) });
      }
      store.unsafeOverwriteForTamperTest(bad.envelopeId, tampered);
      const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry() });
      engine.upsert('own', { title: 'local' }, 1000);
      const result = await engine.sync(store, passphrase, 1001, MIN_KDF_ITERATIONS);
      expect(result.rejectedEnvelopes).toEqual([{ envelopeId: 'env-bad', errorCode: 'CRYPTO_AUTHENTICATION_FAILED' }]);
      expect(result.pulledEnvelopeIds).toContain('env-good');
      expect(result.pushedOperationCount).toBe(1);
      expect(engine.getRow('one')?.title).toBe('good');
    }
  );

  it('rejects a path-traversal envelope ID and continues the same sync', async () => {
    const good = await envelope('env-good', [op('good', time(1000), 'good')]);
    class MaliciousStorage extends InMemoryByoStorageAdapter {
      override async listEnvelopeIds(table?: string): Promise<readonly string[]> {
        return ['../escape', ...await super.listEnvelopeIds(table)];
      }
      override async getEnvelope(id: string): Promise<EncryptedSyncEnvelope | null> {
        if (id === '../escape') return { ...good, envelopeId: id };
        return super.getEnvelope(id);
      }
    }
    const store = new MaliciousStorage();
    await store.putEnvelope(good);
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry() });
    engine.upsert('own', { title: 'local' }, 1000);
    const result = await engine.sync(store, passphrase, 1000, MIN_KDF_ITERATIONS);
    expect(result.rejectedEnvelopes).toEqual([{ envelopeId: '../escape', errorCode: 'UNSAFE_STORAGE_KEY' }]);
    expect(result.pulledEnvelopeIds).toContain('env-good');
    expect(result.pushedOperationCount).toBe(1);
  });

  it('reports malformed base64 instead of aborting later envelope processing', async () => {
    const store = new InMemoryByoStorageAdapter();
    const bad = await envelope('env-bad', [op('bad', time(1000), 'bad')]);
    const good = await envelope('env-good', [op('good', time(1001), 'good')]);
    await store.putEnvelope(bad);
    await store.putEnvelope(good);
    store.unsafeOverwriteForTamperTest(bad.envelopeId, { ...bad, ivBase64: 'A' });
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry() });
    const result = await engine.pullFromStorage(store, passphrase, 1001);
    expect(result.rejectedEnvelopes).toEqual([{ envelopeId: 'env-bad', errorCode: 'INVALID_BASE64' }]);
    expect(result.pulledEnvelopeIds).toContain('env-good');
  });

  it('keeps a failed upload pending and allows a later push to retry', async () => {
    class FailingStorage extends InMemoryByoStorageAdapter {
      fail = true;
      override async putEnvelope(env: EncryptedSyncEnvelope): Promise<void> {
        if (this.fail) throw new Error('offline');
        await super.putEnvelope(env);
      }
    }
    const store = new FailingStorage();
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry() });
    engine.upsert('one', { title: 'pending' }, 1000);
    await expect(engine.pushToStorage(store, passphrase, MIN_KDF_ITERATIONS)).rejects.toThrow('offline');
    expect(engine.getPendingOutboxCount()).toBe(1);
    store.fail = false;
    await engine.pushToStorage(store, passphrase, MIN_KDF_ITERATIONS);
    expect(engine.getPendingOutboxCount()).toBe(0);
  });

  it('retains edits queued during a push and serializes concurrent pushes', async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class SlowStorage extends InMemoryByoStorageAdapter {
      override async putEnvelope(env: EncryptedSyncEnvelope): Promise<void> {
        if (this.inspectAllEnvelopes().length === 0) { started(); await gate; }
        await super.putEnvelope(env);
      }
    }
    const store = new SlowStorage();
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry() });
    engine.upsert('one', { title: 'first' }, 1000);
    const first = engine.pushToStorage(store, passphrase, MIN_KDF_ITERATIONS);
    await startedPromise;
    engine.upsert('two', { title: 'second' }, 1100);
    const second = engine.pushToStorage(store, passphrase, MIN_KDF_ITERATIONS);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a?.operationCount).toBe(1);
    expect(b?.operationCount).toBe(1);
    expect(engine.getPendingOutboxCount()).toBe(0);
    const payloads = await Promise.all(store.inspectAllEnvelopes().map((item) => decryptSyncEnvelope(item, passphrase)));
    expect(payloads.flatMap((payload) => payload.operations.map((item) => item.pk))).toEqual(['one', 'two']);
  });

  it('retains queued operations replaced by a migration during an upload', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const uploadStarted = new Promise<void>((resolve) => { started = resolve; });
    class SlowStorage extends InMemoryByoStorageAdapter {
      override async putEnvelope(env: EncryptedSyncEnvelope): Promise<void> {
        started();
        await gate;
        await super.putEnvelope(env);
      }
    }
    const migrations = new SchemaMigrationRegistry(schema, [{
      fromVersion: 1, toVersion: 2, description: 'rename title',
      operations: [{ kind: 'rename_column', table: 'tasks', from: 'title', to: 'summary' }],
    }]);
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: migrations, initialActiveVersion: 1 });
    const store = new SlowStorage();
    engine.upsert('one', { title: 'before migration' }, 1000);
    const push = engine.pushToStorage(store, passphrase, MIN_KDF_ITERATIONS);
    await uploadStarted;
    engine.migrateToVersion(2);
    release();
    await push;
    expect(engine.getPendingOutbox()).toHaveLength(1);
    expect(engine.getPendingOutbox()[0]?.schemaVersion).toBe(2);
    expect(engine.getPendingOutbox()[0]?.columns.summary?.value).toBe('before migration');
    expect((await decryptSyncEnvelope(store.inspectAllEnvelopes()[0]!, passphrase)).schemaVersion).toBe(1);
    await engine.pushToStorage(store, passphrase, MIN_KDF_ITERATIONS);
    expect(engine.getPendingOutboxCount()).toBe(0);
  });

  it('retains an operation modified during an upload', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const uploadStarted = new Promise<void>((resolve) => { started = resolve; });
    class SlowStorage extends InMemoryByoStorageAdapter {
      override async putEnvelope(env: EncryptedSyncEnvelope): Promise<void> {
        started();
        await gate;
        await super.putEnvelope(env);
      }
    }
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry() });
    const store = new SlowStorage();
    const operation = engine.upsert('one', { title: 'original' }, 1000);
    const push = engine.pushToStorage(store, passphrase, MIN_KDF_ITERATIONS);
    await uploadStarted;
    operation.columns.title = { ...operation.columns.title!, value: 'changed' };
    release();
    await push;
    expect(engine.getPendingOutboxCount()).toBe(1);
    const payload = await decryptSyncEnvelope(store.inspectAllEnvelopes()[0]!, passphrase);
    expect(payload.operations[0]?.columns.title?.value).toBe('original');
  });

  it('includes newer vault clocks in SQL snapshot row clock', async () => {
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry: registry() });
    const store = new InMemoryByoStorageAdapter();
    const future: CrdtChangeOperation = {
      ...op('future', time(2000), 'value'), schemaVersion: 2,
      columns: { id: { value: 'one', hlc: time(1000) }, future: { value: 'later', hlc: time(2000) } },
    };
    await store.putEnvelope(await envelope('env-future', [future]));
    expect((await engine.pullFromStorage(store, passphrase, 2000)).rejectedEnvelopes).toHaveLength(0);
    expect(engine.getRawRowState('one')?.unmappedFields.future?.hlc).toBe(time(2000));
    expect(engine.exportSqlSnapshot('sqlite').upserts[0]?.params[2]).toBe(time(2000));
  });
});
