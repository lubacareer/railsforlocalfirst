import { describe, expect, it } from 'vitest';
import {
  encryptSyncOperations, InMemoryByoStorageAdapter, LocalFirstSyncEngine,
  MIN_KDF_ITERATIONS, MigrationTransformError, SchemaMigrationRegistry,
  type MigrationStep, type TableSchema,
} from '../src/engine';

const schema: TableSchema = {
  tableName: 'items', version: 1, primaryKey: 'id', columns: [
    { name: 'id', type: 'TEXT', nullable: false },
    { name: 'value', type: 'INTEGER', nullable: false, defaultValue: 1 },
  ],
};
const password = 'correct-horse-battery-2026';
const failures: { name: string; create: () => unknown }[] = [
  { name: 'Error', create: () => new Error('transform unavailable') },
  { name: 'null-prototype object', create: () => Object.create(null) },
  { name: 'throwing conversion', create: () => ({ toString() { throw new Error('conversion failed'); } }) },
  { name: 'throwing message getter', create: () => Object.defineProperty(new Error(), 'message', {
    get() { throw new Error('message failed'); },
  }) },
  { name: 'revoked proxy', create: () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  } },
];

describe('migration transform failures', () => {
  it.each(failures)('handles $name while rolling back, continuing, pushing and retrying', async ({ create }) => {
    let fail = true;
    const failure = create();
    const step: MigrationStep = { fromVersion: 1, toVersion: 2, description: 'transform', operations: [
      { kind: 'transform_column', table: 'items', column: 'value', fnName: 'convert', transform: value => {
        if (value === 7 && fail) throw failure;
        return Number(value) * 2;
      } },
    ] };
    const registry = new SchemaMigrationRegistry(schema, [step]);
    const sender = new LocalFirstSyncEngine({ nodeId: 'remote', registry, initialActiveVersion: 1 });
    const first = sender.upsert('first', { value: 2 }, 900);
    const bad = sender.upsert('bad', { value: 7 }, 950);
    const good = sender.upsert('good', { value: 3 }, 1000);
    const storage = new InMemoryByoStorageAdapter();
    for (const [envelopeId, operations] of [['bad-envelope', [first, bad]], ['good-envelope', [good]]] as const) {
      await storage.putEnvelope(await encryptSyncOperations({ envelopeId, operations, nodeId: 'remote',
        table: 'items', schemaVersion: 1, passphrase: password, kdfIterations: MIN_KDF_ITERATIONS }));
    }
    const receiver = new LocalFirstSyncEngine({ nodeId: 'local', registry, initialActiveVersion: 2 });
    receiver.upsert('own', { value: 4 }, 1100);
    const result = await receiver.sync(storage, password, 1200, MIN_KDF_ITERATIONS);
    expect(result.rejectedEnvelopes).toEqual([{ envelopeId: 'bad-envelope', errorCode: 'MIGRATION_TRANSFORM_FAILED' }]);
    expect(result.pulledEnvelopeIds).toContain('good-envelope');
    expect(result.appliedOperationCount).toBe(1);
    expect(result.pushedOperationCount).toBe(1);
    expect(receiver.getPendingOutboxCount()).toBe(0);
    expect(receiver.getRow('first')).toBeNull();
    expect(receiver.getRow('bad')).toBeNull();
    expect(receiver.getRow('good')?.value).toBe(6);
    expect(receiver.getConflictLog()).toHaveLength(0);

    // Environment-dependent transform failures are retryable without clearing quarantine.
    fail = false;
    const retried = await receiver.pullFromStorage(storage, password, 1300);
    expect(retried.rejectedEnvelopes).toEqual([]);
    expect(retried.pulledEnvelopeIds).toContain('bad-envelope');
    expect(receiver.getRow('first')?.value).toBe(4);
    expect(receiver.getRow('bad')?.value).toBe(14);
  });

  it.each(failures)('preserves the original $name cause when local migration throws', ({ create }) => {
    const failure = create();
    const registry = new SchemaMigrationRegistry(schema, [{ fromVersion: 1, toVersion: 2, description: 'transform', operations: [
      { kind: 'transform_column', table: 'items', column: 'value', fnName: 'convert', transform: value => {
        if (value === 7) throw failure;
        return value;
      } },
    ] }]);
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry, initialActiveVersion: 1 });
    engine.upsert('one', { value: 7 }, 1000);
    try {
      engine.migrateToVersion(2);
      expect.fail('migration should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationTransformError);
      expect((error as MigrationTransformError).code).toBe('MIGRATION_TRANSFORM_FAILED');
      expect((error as MigrationTransformError).cause).toBe(failure);
      expect(engine.getCurrentVersion()).toBe(1);
      expect(engine.getRow('one')?.value).toBe(7);
    }
  });

  it('restores queued operations, all rows, version and conflict history after partial migration', () => {
    const registry = new SchemaMigrationRegistry(schema, [{ fromVersion: 1, toVersion: 2, description: 'transform', operations: [
      { kind: 'transform_column', table: 'items', column: 'value', fnName: 'convert', transform: value => {
        if (value === 7) throw new Error('second queued operation fails');
        return Number(value) * 2;
      } },
    ] }]);
    const engine = new LocalFirstSyncEngine({ nodeId: 'local', registry, initialActiveVersion: 1 });
    engine.upsert('first', { value: 2 }, 1000);
    engine.upsert('second', { value: 7 }, 1100);
    engine.upsert('second', { value: 3 }, 1200);
    const outbox = JSON.stringify(engine.getPendingOutbox());
    const rows = JSON.stringify(engine.listRawRowStates());
    const conflicts = JSON.stringify(engine.getConflictLog());
    expect(engine.getPendingOutboxCount()).toBe(3);
    expect(engine.getConflictLog().length).toBeGreaterThan(0);
    expect(() => engine.migrateToVersion(2)).toThrow(/second queued operation fails/);
    expect(engine.getCurrentVersion()).toBe(1);
    expect(JSON.stringify(engine.getPendingOutbox())).toBe(outbox);
    expect(JSON.stringify(engine.listRawRowStates())).toBe(rows);
    expect(JSON.stringify(engine.getConflictLog())).toBe(conflicts);
  });
});
