import { bench, describe } from 'vitest';
import {
  encryptSyncOperations,
  formatHlc,
  mergeCrdtRowStates,
  MIN_KDF_ITERATIONS,
  SchemaMigrationRegistry,
  type CrdtChangeOperation,
  type CrdtRowState,
  type TableSchema,
} from '../../src/engine';

const schema: TableSchema = {
  tableName: 'tasks', version: 1, primaryKey: 'id', columns: [
    { name: 'id', type: 'TEXT', nullable: false },
    { name: 'title', type: 'TEXT', nullable: false, defaultValue: '' },
    { name: 'estimate', type: 'INTEGER', nullable: false, defaultValue: 1 },
  ],
};
const registry = new SchemaMigrationRegistry(schema, [{
  fromVersion: 1, toVersion: 2, description: 'Convert estimate to minutes',
  operations: [{ kind: 'transform_column', table: 'tasks', column: 'estimate',
    fnName: 'hours_to_minutes', transform: value => Number(value) * 60 }],
}]);
const hlc = formatHlc({ wallTimeMs: 1_000, counter: 0, nodeId: 'bench' });
const laterHlc = formatHlc({ wallTimeMs: 2_000, counter: 0, nodeId: 'bench' });
const operation: CrdtChangeOperation = {
  opId: 'bench-op', table: 'tasks', pk: 'task-1', nodeId: 'bench', schemaVersion: 1,
  kind: 'upsert', hlc, columns: {
    id: { value: 'task-1', hlc }, title: { value: 'Fix sync', hlc }, estimate: { value: 3, hlc },
  },
};
const first: CrdtRowState = {
  table: 'tasks', pk: 'task-1', schemaVersion: 1, tombstoneHlc: null,
  cells: operation.columns, unmappedFields: {},
};
const second: CrdtRowState = {
  ...first, cells: { ...first.cells, title: { value: 'Review sync', hlc: laterHlc } },
};

describe('Local-first engine', () => {
  bench('merge concurrent CRDT row states', () => { mergeCrdtRowStates(first, second); });
  bench('upcast an older schema operation', () => { registry.normalizeChangeOperation(operation, 2); });
  bench('encrypt a single operation', async () => {
    await encryptSyncOperations({
      envelopeId: 'bench-envelope', nodeId: 'bench', table: 'tasks', schemaVersion: 1,
      operations: [operation], passphrase: 'benchmark-only-passphrase', kdfIterations: MIN_KDF_ITERATIONS,
    });
  }, { time: 250, iterations: 3, warmupIterations: 1 });
});
