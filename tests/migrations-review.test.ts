import { describe, expect, it } from 'vitest';
import { sqliteAvailable as hasSqlite } from './support/sqlite';
import {
  compileCreateTableSql, compileParameterizedInsert, createSqliteAdapter, formatHlc,
  LocalFirstSyncEngine, migrateSqlTable, SchemaMigrationRegistry, validateTableSchema,
  type MigrationStep, type TableSchema,
} from '../src/engine';

const schema: TableSchema = {
  tableName: 'items', version: 1, primaryKey: 'id', columns: [
    { name: 'id', type: 'TEXT', nullable: false },
    { name: 'original', type: 'TEXT', nullable: false },
    { name: 'flag', type: 'BOOLEAN', nullable: true },
    { name: 'document', type: 'JSON', nullable: true },
  ],
};
const hlc = (wallTimeMs: number) => formatHlc({ wallTimeMs, counter: 0, nodeId: 'node' });

describe('SQL migration metadata', () => {
  it.each(['_crdt_hlc', '_column_hlcs', '_column_tie_values', '_schema_version', '_unmapped_vault', '_tombstone_hlc', '_causal_version', '_COLUMN_HLCS'])('reserves %s', name => {
    expect(() => validateTableSchema({ ...schema, columns: [...schema.columns, { name, type: 'TEXT', nullable: true }] })).toThrow(/RESERVED_METADATA_COLUMN/);
  });

  it.skipIf(!hasSqlite)('executes backfill, rename, and boolean/JSON vault archive using the in-memory upcaster', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const migration: MigrationStep = { fromVersion: 1, toVersion: 2, description: 'metadata', operations: [
      { kind: 'add_column', table: 'items', column: { name: 'copy', type: 'TEXT', nullable: false, defaultValue: 'default' }, backfillFromColumn: 'original' },
      { kind: 'rename_column', table: 'items', from: 'original', to: 'renamed' },
      { kind: 'drop_column_to_vault', table: 'items', column: 'flag' },
      { kind: 'drop_column_to_vault', table: 'items', column: 'document' },
    ] };
    const registry = new SchemaMigrationRegistry(schema, [migration]);
    const engine = new LocalFirstSyncEngine({ nodeId: 'node', registry, initialActiveVersion: 1 });
    engine.upsert('1', { original: 'source', flag: true, document: '{ "a": 1 }' }, 10);
    engine.upsert('2', { original: 'other', flag: null }, 20);
    const snapshot = engine.exportSqlSnapshot('sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(snapshot.ddl);
    const adapter = createSqliteAdapter(db);
    const { mergeSqlRowState, listLiveSqlRows } = await import('../src/engine');
    for (const row of snapshot.rows) await mergeSqlRowState(adapter, registry, row);
    await migrateSqlTable(adapter, registry, 1, 2);
    engine.migrateToVersion(2);
    const rows = await listLiveSqlRows(adapter, registry.getSchemaAtVersion(2));
    expect(rows).toEqual(engine.listRawRowStates());
    expect(rows[0]?.cells.copy?.value).toBe('source');
    expect(rows[0]?.cells.copy?.hlc).toBe(rows[0]?.cells.renamed?.hlc);
    expect(rows[0]?.unmappedFields.flag?.value).toBe(true);
    expect(rows[1]?.unmappedFields.flag?.value).toBeNull();
    expect(rows[0]?.unmappedFields.document?.value).toBe('{ "a": 1 }');
    db.close();
  });

  it.each(['sqlite', 'postgres'] as const)('provides a complete application migration step for %s', dialect => {
    const migration: MigrationStep = { fromVersion: 1, toVersion: 2, description: 'rename and transform', operations: [
      { kind: 'rename_column', table: 'items', from: 'original', to: 'renamed' },
      { kind: 'transform_column', table: 'items', column: 'renamed', fnName: 'length', targetType: 'INTEGER', transform: v => String(v).length },
    ] };
    const registry = new SchemaMigrationRegistry(schema, [migration]);
    const step = registry.compileMigrationPlan(1, 2, dialect)[0]!;
    expect(step.kind).toBe('application_migration');
    if (step.kind !== 'application_migration') throw new Error('expected application migration');
    expect(step.step.operations).toHaveLength(2);
    expect(step.targetSchema.columns.find(c => c.name === 'renamed')?.type).toBe('INTEGER');
  });

  it('applies value-only transforms identically to full rows and sparse operations', () => {
    const transform: MigrationStep = { fromVersion: 1, toVersion: 2, description: 'transform', operations: [
      { kind: 'transform_column', table: 'items', column: 'original', fnName: 'double', transform: v => String(v) + String(v) },
    ] };
    const registry = new SchemaMigrationRegistry(schema, [transform]);
    const engine = new LocalFirstSyncEngine({ nodeId: 'node', registry, initialActiveVersion: 1 });
    const op = engine.upsert('1', { original: 'x' }, 1);
    const normalized = registry.normalizeChangeOperation(op, 2).operation;
    engine.migrateToVersion(2);
    expect(normalized.columns.original?.value).toBe('xx');
    expect(engine.getRawRowState('1')?.cells.original?.value).toBe('xx');
  });

  it.skipIf(!hasSqlite)('uses default when a backfill source is absent from schema', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const migration: MigrationStep = { fromVersion: 1, toVersion: 2, description: 'missing source', operations: [
      { kind: 'add_column', table: 'items', column: { name: 'copy', type: 'TEXT', nullable: false, defaultValue: 'fallback' }, backfillFromColumn: 'missing_source' },
    ] };
    const registry = new SchemaMigrationRegistry(schema, [migration]);
    const db = new DatabaseSync(':memory:');
    db.exec(compileCreateTableSql(schema, 'sqlite'));
    const q = compileParameterizedInsert(schema, { id: '1', original: 'x', flag: null, document: null }, hlc(1), '{}', 'sqlite', JSON.stringify({ id: hlc(1), original: hlc(1) }));
    db.prepare(q.sql).run(...(q.params as readonly (string | number | null)[]));
    await migrateSqlTable(createSqliteAdapter(db), registry, 1, 2);
    expect(db.prepare('SELECT copy FROM items').get()?.copy).toBe('fallback');
    db.close();
  });
});
