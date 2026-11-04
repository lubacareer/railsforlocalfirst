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

describe('migration transform failures', () => {
  it('rolls back a rejected envelope, applies later envelopes, pushes local work and retries', async () => {
    let fail = true;
    const failure = new Error('transform unavailable');
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

  it('preserves the cause when local migration throws', () => {
    const failure = new Error('local transform unavailable');
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
      expect(error).toMatchObject({ code: 'MIGRATION_TRANSFORM_FAILED', cause: failure });
      expect(engine.getCurrentVersion()).toBe(1);
      expect(engine.getRow('one')?.value).toBe(7);
    }
  });
});
