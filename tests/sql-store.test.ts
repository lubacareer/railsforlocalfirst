import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sqliteAvailable } from './support/sqlite';
import {
  compileCreateTableSql, createPostgresAdapter, createSqliteAdapter, formatHlc,
  listLiveSqlRows, mergeCrdtRowStates, mergeSqlRowState, migrateSqlTable, SchemaMigrationRegistry,
  type CrdtRowState, type SqlDatabaseAdapter, type TableSchema,
} from '../src/engine';

const postgresUrl = process.env.TEST_POSTGRES_URL;
if (process.env.REQUIRE_POSTGRES_TESTS === '1' && !postgresUrl) {
  throw new Error('TEST_POSTGRES_URL is required when REQUIRE_POSTGRES_TESTS=1');
}
const clock = (wallTimeMs: number, nodeId = 'remote') => formatHlc({ wallTimeMs, counter: 0, nodeId });
const schemaFor = (tableName: string): TableSchema => ({
  tableName, version: 1, primaryKey: 'id', columns: [
    { name: 'id', type: 'TEXT', nullable: false },
    { name: 'title', type: 'TEXT', nullable: false, defaultValue: '' },
    { name: 'tag', type: 'TEXT', nullable: false, defaultValue: '' },
  ],
});
const state = (schema: TableSchema, changes: Partial<CrdtRowState> = {}): CrdtRowState => ({
  table: schema.tableName, pk: 'row1', schemaVersion: 1, tombstoneHlc: null,
  cells: { id: { value: 'row1', hlc: clock(1) } }, unmappedFields: {}, ...changes,
});

type Fixture = { adapter: SqlDatabaseAdapter; schema: TableSchema; close(): Promise<void> };
async function fixture(dialect: 'sqlite' | 'postgres'): Promise<Fixture> {
  const schema = schemaFor(`Items_${crypto.randomUUID().replace(/-/g, '')}`);
  if (dialect === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const connection = new DatabaseSync(':memory:');
    connection.exec(compileCreateTableSql(schema, 'sqlite'));
    return { schema, adapter: createSqliteAdapter(connection), async close() { connection.close(); } };
  }
  const pool = new Pool({ connectionString: postgresUrl });
  await pool.query(compileCreateTableSql(schema, 'postgres'));
  return { schema, adapter: createPostgresAdapter(pool), async close() { await pool.query(`DROP TABLE IF EXISTS "${schema.tableName}"`); await pool.end(); } };
}

describe.each([
  { dialect: 'sqlite' as const, skip: !sqliteAvailable },
  { dialect: 'postgres' as const, skip: !postgresUrl },
])('$dialect CRDT persistence', ({ dialect, skip }) => {
  let active: Fixture | undefined;
  afterEach(async () => { if (active) await active.close(); active = undefined; });

  it.skipIf(skip)('merges independently changed fields in either order and under concurrent creation', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema);
    const a = state(schema, { cells: { id: { value: 'row1', hlc: clock(1) }, title: { value: 'new title', hlc: clock(10) }, tag: { value: 'old tag', hlc: clock(2) } } });
    const b = state(schema, { cells: { id: { value: 'row1', hlc: clock(1) }, title: { value: 'old title', hlc: clock(3) }, tag: { value: 'new tag', hlc: clock(20) } } });
    await Promise.all([mergeSqlRowState(adapter, registry, a), mergeSqlRowState(adapter, registry, b)]);
    let rows = await listLiveSqlRows(adapter, schema);
    expect(rows[0]?.cells.title?.value).toBe('new title');
    expect(rows[0]?.cells.tag?.value).toBe('new tag');
    await mergeSqlRowState(adapter, registry, b);
    await mergeSqlRowState(adapter, registry, a);
    rows = await listLiveSqlRows(adapter, schema);
    expect(rows[0]).toEqual(mergeCrdtRowStates(a, b));
    const secondA = { ...a, pk: 'row2', cells: { ...a.cells, id: { value: 'row2', hlc: clock(1) } } };
    const secondB = { ...b, pk: 'row2', cells: { ...b.cells, id: { value: 'row2', hlc: clock(1) } } };
    await mergeSqlRowState(adapter, registry, secondB);
    await mergeSqlRowState(adapter, registry, secondA);
    expect((await listLiveSqlRows(adapter, schema)).find(row => row.pk === 'row2')).toEqual(mergeCrdtRowStates(secondA, secondB));
  });

  it.skipIf(skip)('uses exact deterministic value ties and merges overlapping vault entries', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema);
    const t = clock(50);
    const a = state(schema, { cells: { id: { value: 'row1', hlc: clock(1) }, title: { value: '\u{10000}', hlc: t } },
      unmappedFields: { future: { value: true, hlc: t, sourceVersion: 2, schemaPosition: 'end' } } });
    const b = state(schema, { cells: { id: { value: 'row1', hlc: clock(1) }, title: { value: '\uE000', hlc: t } },
      unmappedFields: { future: { value: 'text', hlc: t, sourceVersion: 2, schemaPosition: 'end' } } });
    await mergeSqlRowState(adapter, registry, a);
    await mergeSqlRowState(adapter, registry, b);
    const [result] = await listLiveSqlRows(adapter, schema);
    expect(result).toEqual(mergeCrdtRowStates(a, b));
    expect(result?.cells.title?.value).toBe('\uE000');
    expect(result?.unmappedFields.future?.value).toBe('text');
  });

  it.skipIf(skip)('preserves null tie values and stable ordering through an order-reversing transform', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema, [{ fromVersion: 1, toVersion: 2, description: 'reverse', operations: [
      { kind: 'transform_column', table: schema.tableName, column: 'title', fnName: 'reverse_order', transform: v => v === 'a' ? 'z' : v === 'b' ? 'a' : v },
    ] }]);
    const a = state(schema, { cells: { id: { value: 'row1', hlc: clock(1), tieValue: null }, title: { value: 'a', hlc: clock(10) } } });
    const b = state(schema, { cells: { id: { value: 'row1', hlc: clock(1), tieValue: null }, title: { value: 'b', hlc: clock(10) } } });
    await mergeSqlRowState(adapter, registry, a);
    expect((await listLiveSqlRows(adapter, schema))[0]?.cells.id?.tieValue).toBeNull();
    await migrateSqlTable(adapter, registry, 1, 2);
    const upcastedB = registry.upcastRowState(b, 2).row;
    const actual = await mergeSqlRowState(adapter, registry, upcastedB);
    const expected = registry.upcastRowState(mergeCrdtRowStates(a, b), 2).row;
    expect(actual).toEqual(expected);
    expect(actual.cells.title?.value).toBe('a');
  });

  it.skipIf(skip)('retains tombstones, hides deleted rows, and permits newer resurrection', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema);
    const created = state(schema, { cells: { id: { value: 'row1', hlc: clock(1) }, title: { value: 'old', hlc: clock(10) } } });
    const deleted = state(schema, { tombstoneHlc: clock(20) });
    await mergeSqlRowState(adapter, registry, created);
    await mergeSqlRowState(adapter, registry, deleted);
    expect(await listLiveSqlRows(adapter, schema)).toEqual([]);
    const resurrect = state(schema, { cells: { id: { value: 'row1', hlc: clock(1) }, title: { value: 'back', hlc: clock(30) } } });
    const result = await mergeSqlRowState(adapter, registry, resurrect);
    expect(result.tombstoneHlc).toBe(clock(20));
    expect((await listLiveSqlRows(adapter, schema))[0]?.cells.title?.value).toBe('back');
  });

  it.skipIf(skip)('executes schema migration and preserves per-cell metadata, vault, and tombstones', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema, [{ fromVersion: 1, toVersion: 2, description: 'transform and drop', operations: [
      { kind: 'transform_column', table: schema.tableName, column: 'title', fnName: 'length', targetType: 'INTEGER', transform: v => String(v).length },
      { kind: 'drop_column_to_vault', table: schema.tableName, column: 'tag' },
    ] }]);
    const original = state(schema, { cells: { id: { value: 'row1', hlc: clock(1) }, title: { value: 'abc', hlc: clock(10) }, tag: { value: 'archived', hlc: clock(11) } }, tombstoneHlc: clock(20) });
    await mergeSqlRowState(adapter, registry, original);
    await migrateSqlTable(adapter, registry, 1, 2);
    const target = registry.getSchemaAtVersion(2);
    expect(await listLiveSqlRows(adapter, target)).toEqual([]);
    const resurrect = { ...registry.upcastRowState(original, 2).row, tombstoneHlc: null,
      cells: { ...registry.upcastRowState(original, 2).row.cells, title: { value: 9, hlc: clock(30) } } };
    const merged = await mergeSqlRowState(adapter, registry, resurrect);
    expect(merged.cells.title?.value).toBe(9);
    expect(merged.unmappedFields.tag?.value).toBe('archived');
    expect(merged.tombstoneHlc).toBe(clock(20));
  });

  it.skipIf(skip)('rolls back the database when an application transform fails', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema, [{ fromVersion: 1, toVersion: 2, description: 'failing transform', operations: [
      { kind: 'transform_column', table: schema.tableName, column: 'title', fnName: 'fail', transform: v => { if (v === 'bad') throw new Error('transform failed'); return v; } },
    ] }]);
    const original = state(schema, { cells: { id: { value: 'row1', hlc: clock(1) }, title: { value: 'bad', hlc: clock(10) } } });
    await mergeSqlRowState(adapter, registry, original);
    await expect(migrateSqlTable(adapter, registry, 1, 2)).rejects.toThrow('transform failed');
    expect(await listLiveSqlRows(adapter, schema)).toEqual([original]);
  });

  it.skipIf(skip)('rejects schema rebuilds that would discard application indexes', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema, [{ fromVersion: 1, toVersion: 2, description: 'add', operations: [
      { kind: 'add_column', table: schema.tableName, column: { name: 'next', type: 'TEXT', nullable: true } },
    ] }]);
    const original = state(schema);
    await mergeSqlRowState(adapter, registry, original);
    await adapter.withWriteTransaction(async tx => { await tx.query(`CREATE INDEX "${schema.tableName}_idx" ON "${schema.tableName}" (title)`); });
    await expect(migrateSqlTable(adapter, registry, 1, 2)).rejects.toMatchObject({ code: 'SQL_MIGRATION_UNSUPPORTED_DEPENDENCY' });
    expect(await listLiveSqlRows(adapter, schema)).toEqual([original]);
  });

  it.skipIf(skip)('rejects unknown SQL cells before persisting them', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema);
    const bad = state(schema, { cells: { id: { value: 'row1', hlc: clock(1) }, unknown: { value: 'not in schema', hlc: clock(2) } } });
    await expect(mergeSqlRowState(adapter, registry, bad)).rejects.toMatchObject({ code: 'UNKNOWN_COLUMN_FOR_SCHEMA_VERSION' });
    expect(await listLiveSqlRows(adapter, schema)).toEqual([]);
  });

  it.skipIf(skip)('requires old snapshots without causal metadata to be regenerated', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const legacy = { ...schema, tableName: `${schema.tableName}_old` };
    const registry = new SchemaMigrationRegistry(legacy);
    await adapter.withWriteTransaction(async tx => { await tx.query(`CREATE TABLE "${legacy.tableName}" (id TEXT PRIMARY KEY)`); });
    try {
      await expect(mergeSqlRowState(adapter, registry, state(legacy))).rejects.toMatchObject({ code: 'SQL_SNAPSHOT_REGENERATION_REQUIRED' });
    } finally {
      await adapter.withWriteTransaction(async tx => { await tx.query(`DROP TABLE "${legacy.tableName}"`); });
    }
  });

  it.skipIf(skip)('rejects malformed vault provenance on both input and persisted rows', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema);
    const malformed = state(schema, { unmappedFields: { future: { value: 'x', hlc: clock(2), sourceVersion: 0 } } });
    await expect(mergeSqlRowState(adapter, registry, malformed)).rejects.toBeDefined();
    expect(await listLiveSqlRows(adapter, schema)).toEqual([]);
    await mergeSqlRowState(adapter, registry, state(schema));
    const marker = dialect === 'postgres' ? '$1' : '?';
    await adapter.withWriteTransaction(async tx => {
      await tx.query(`UPDATE "${schema.tableName}" SET "_unmapped_vault" = ${marker}`, [JSON.stringify(malformed.unmappedFields)]);
    });
    await expect(listLiveSqlRows(adapter, schema)).rejects.toBeDefined();
  });

  it.skipIf(skip || dialect !== 'postgres')('refuses a PostgreSQL rebuild when grants or security policies would be lost', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema, [{ fromVersion: 1, toVersion: 2, description: 'add', operations: [
      { kind: 'add_column', table: schema.tableName, column: { name: 'next', type: 'TEXT', nullable: true } },
    ] }]);
    await mergeSqlRowState(adapter, registry, state(schema));
    await adapter.withWriteTransaction(async tx => { await tx.query(`GRANT SELECT ON "${schema.tableName}" TO PUBLIC`); });
    await expect(migrateSqlTable(adapter, registry, 1, 2)).rejects.toMatchObject({ code: 'SQL_MIGRATION_UNSUPPORTED_DEPENDENCY' });
    expect(await listLiveSqlRows(adapter, schema)).toHaveLength(1);
  });

  it.skipIf(skip || dialect !== 'postgres')('refuses a PostgreSQL rebuild when even a disabled RLS policy would be lost', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema, [{ fromVersion: 1, toVersion: 2, description: 'add', operations: [
      { kind: 'add_column', table: schema.tableName, column: { name: 'next', type: 'TEXT', nullable: true } },
    ] }]);
    await mergeSqlRowState(adapter, registry, state(schema));
    await adapter.withWriteTransaction(async tx => { await tx.query(`CREATE POLICY guard ON "${schema.tableName}" USING (true)`); });
    await expect(migrateSqlTable(adapter, registry, 1, 2)).rejects.toMatchObject({ code: 'SQL_MIGRATION_UNSUPPORTED_DEPENDENCY' });
    expect(await listLiveSqlRows(adapter, schema)).toHaveLength(1);
  });

  it.skipIf(skip)('refuses to drop unknown application columns during migration', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema, [{ fromVersion: 1, toVersion: 2, description: 'add', operations: [
      { kind: 'add_column', table: schema.tableName, column: { name: 'next', type: 'TEXT', nullable: true } },
    ] }]);
    await mergeSqlRowState(adapter, registry, state(schema));
    await adapter.withWriteTransaction(async tx => { await tx.query(`ALTER TABLE "${schema.tableName}" ADD COLUMN extra TEXT`); });
    await expect(migrateSqlTable(adapter, registry, 1, 2)).rejects.toMatchObject({ code: 'SQL_MIGRATION_UNSUPPORTED_DEPENDENCY' });
    expect(await listLiveSqlRows(adapter, schema)).toHaveLength(1);
  });

  it.skipIf(skip)('keeps a future value through an intermediate migration and restores it only at its version', async () => {
    active = await fixture(dialect);
    const { adapter, schema } = active;
    const registry = new SchemaMigrationRegistry(schema, [
      { fromVersion: 1, toVersion: 2, description: 'add', operations: [
        { kind: 'add_column', table: schema.tableName, column: { name: 'estimate', type: 'INTEGER', nullable: false, defaultValue: 1 } },
      ] },
      { fromVersion: 2, toVersion: 3, description: 'transform', operations: [
        { kind: 'transform_column', table: schema.tableName, column: 'estimate', targetType: 'TEXT', fnName: 'stringify', transform: v => String(v) },
      ] },
    ]);
    const original = state(schema, { unmappedFields: { estimate: { value: 'future', hlc: clock(10), sourceVersion: 3, schemaPosition: 'end' } } });
    await mergeSqlRowState(adapter, registry, original);
    await migrateSqlTable(adapter, registry, 1, 2);
    const [intermediate] = await listLiveSqlRows(adapter, registry.getSchemaAtVersion(2));
    expect(intermediate?.cells.estimate?.value).toBe(1);
    expect(intermediate?.unmappedFields.estimate?.value).toBe('future');
    await migrateSqlTable(adapter, registry, 2, 3);
    const [final] = await listLiveSqlRows(adapter, registry.getSchemaAtVersion(3));
    expect(final?.cells.estimate?.value).toBe('future');
    expect(final?.unmappedFields.estimate).toBeUndefined();
  });
});
