import { describe, expect, it } from 'vitest';
import {
  encryptSyncOperations, formatHlc, InMemoryByoStorageAdapter, LocalFirstSyncEngine,
  MAX_STRING_CELL_LENGTH, MIN_KDF_ITERATIONS, SchemaMigrationRegistry,
  type CrdtChangeOperation, type ScalarValue, type TableSchema,
} from '../src/engine';

const schema: TableSchema = { tableName: 'items', version: 1, primaryKey: 'id', columns: [
  { name: 'id', type: 'TEXT', nullable: false },
  { name: 'value', type: 'INTEGER', nullable: false, defaultValue: 1 },
] };
const password = 'scalar-transform-retry-password';
const time = (wallTimeMs: number) => formatHlc({ wallTimeMs, counter: 0, nodeId: 'remote' });
const operation = (pk: string, value: number, schemaVersion = 2, wallTimeMs = 1000): CrdtChangeOperation => ({
  opId: `op-${pk}`, table: 'items', pk, schemaVersion, nodeId: 'remote', kind: 'upsert',
  hlc: time(wallTimeMs), columns: {
    id: { value: pk, hlc: time(wallTimeMs) }, value: { value, hlc: time(wallTimeMs) },
  },
});

function registryFor(transform: (value: ScalarValue) => ScalarValue): SchemaMigrationRegistry {
  return new SchemaMigrationRegistry(schema, [{ fromVersion: 1, toVersion: 2, description: 'double', operations: [
    { kind: 'transform_column', table: 'items', column: 'value', fnName: 'double', transform },
  ] }]);
}

async function expectRetryAfterLocalRepair(
  registry: SchemaMigrationRegistry, bad: CrdtChangeOperation, errorCode: string, repair: () => void,
) {
  const storage = new InMemoryByoStorageAdapter();
  for (const [envelopeId, operations] of [
    ['bad-envelope', [operation('first', 4, 2, 900), bad]],
    ['later-envelope', [operation('later', 6, 2, 1100)]],
  ] as const) {
    await storage.putEnvelope(await encryptSyncOperations({ envelopeId, operations,
      nodeId: 'remote', table: 'items', schemaVersion: 2, passphrase: password,
      kdfIterations: MIN_KDF_ITERATIONS }));
  }
  const receiver = new LocalFirstSyncEngine({ nodeId: 'local', registry });
  receiver.upsert('own', { value: 4 }, 1150);
  const before = [...receiver.getConflictLog()];
  const rejected = [{ envelopeId: 'bad-envelope', errorCode }];
  const first = await receiver.sync(storage, password, 1200, MIN_KDF_ITERATIONS);
  expect(first.rejectedEnvelopes).toEqual(rejected);
  expect(first.pulledEnvelopeIds).toEqual(['later-envelope']);
  expect(first.appliedOperationCount).toBe(1);
  expect(first.pushedOperationCount).toBe(1);
  expect(receiver.getPendingOutboxCount()).toBe(0);
  expect(receiver.getRow('first')).toBeNull();
  expect(receiver.getRow('bad')).toBeNull();
  expect(receiver.getRow('later')?.value).toBe(6);
  expect(receiver.getConflictLog()).toEqual(before);

  // These values came from local migration code, not the authenticated payload.
  // Retrying must remain possible without explicitly clearing quarantine.
  expect((await receiver.pullFromStorage(storage, password, 1250)).rejectedEnvelopes).toEqual(rejected);
  expect(receiver.getRow('first')).toBeNull();
  expect(receiver.getRow('bad')).toBeNull();
  repair();
  const retried = await receiver.pullFromStorage(storage, password, 1300);
  expect(retried.rejectedEnvelopes).toEqual([]);
  expect(retried.pulledEnvelopeIds).toContain('bad-envelope');
  expect(receiver.getRow('first')?.value).toBe(4);
  expect(receiver.getRow('bad')?.value).toBe(14);
  expect(receiver.listRawRowStates().find(row => row.pk === 'bad')?.unmappedFields.value).toBeUndefined();
}

describe('retrying invalid local transform outputs', () => {
  it.each([
    ['object', {}, 'UNSUPPORTED_SCALAR_TYPE'],
    ['NaN', NaN, 'NON_FINITE_NUMBER'],
    ['oversized string', 'a'.repeat(MAX_STRING_CELL_LENGTH + 1), 'VALUE_TOO_LARGE'],
    ['wrong type', 'invalid integer', 'TYPE_MISMATCH'],
  ] as const)('retries an active-cell transform returning %s until repaired', async (_name, invalid, code) => {
    let fail = true;
    const registry = registryFor(value => value === 7 && fail ? invalid as ScalarValue : Number(value) * 2);
    await expectRetryAfterLocalRepair(registry, operation('bad', 7, 1), code, () => { fail = false; });
  });

  it('retries a vault-restoration transform returning an invalid scalar until repaired', async () => {
    let fail = true;
    const registry = registryFor(value => value === 7 && fail ? {} as ScalarValue : Number(value) * 2);
    const bad = operation('bad', 0);
    delete bad.columns.value;
    await expectRetryAfterLocalRepair(registry, { ...bad, unmappedFields: {
      value: { value: 7, hlc: time(1000), sourceVersion: 1, schemaPosition: 'end' },
    } }, 'UNSUPPORTED_SCALAR_TYPE', () => { fail = false; });
  });

  it('retries an invalid transformed default evaluated during incoming migration until repaired', async () => {
    let fail = false;
    const registry = registryFor(value => value === 1 && fail ? {} as ScalarValue : Number(value) * 2);
    // Registration used a valid default; the local function changes before the pull.
    fail = true;
    await expectRetryAfterLocalRepair(registry, operation('bad', 7, 1), 'UNSUPPORTED_SCALAR_TYPE', () => { fail = false; });
  });
});
