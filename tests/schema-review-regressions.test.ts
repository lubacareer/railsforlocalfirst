import { describe, expect, it } from 'vitest';
import { sqliteAvailable as hasSqlite } from './support/sqlite';
import {
  compileCreateTableSql, createSqliteAdapter, LocalFirstSyncEngine, mergeSqlRowState,
  migrateSqlTable, SchemaMigrationRegistry, validateTableSchema,
  type MigrationStep, type TableSchema,
} from '../src/engine';

const schema: TableSchema = {
  tableName: 'items', version: 1, primaryKey: 'id', columns: [
    { name: 'id', type: 'TEXT', nullable: false },
    { name: 'estimate', type: 'INTEGER', nullable: false, defaultValue: 1 },
  ],
};
const transform: MigrationStep = {
  fromVersion: 1, toVersion: 2, description: 'hours to minutes', operations: [
    { kind: 'transform_column', table: 'items', column: 'estimate', fnName: 'minutes', transform: value => Number(value) * 60 },
  ],
};

describe('schema review regressions', () => {
  it.each(['INTEGER', 'REAL', 'BOOLEAN', 'JSON'] as const)('rejects a %s primary key', type => {
    expect(() => validateTableSchema({ ...schema, columns: [{ name: 'id', type, nullable: false }] })).toThrow(/INVALID_PRIMARY_KEY_TYPE/);
  });

  it('rejects transforms of the primary key', () => {
    expect(() => new SchemaMigrationRegistry(schema, [{ ...transform, operations: [
      { kind: 'transform_column', table: 'items', column: 'id', fnName: 'uppercase', transform: value => String(value).toUpperCase() },
    ] }])).toThrow(/CANNOT_TRANSFORM_PRIMARY_KEY/);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects unsafe schema field %s', name => {
    expect(() => validateTableSchema({ ...schema, columns: [...schema.columns, { name, type: 'TEXT', nullable: true }] })).toThrow(/PROTOTYPE_POLLUTION_DETECTED/);
    expect(() => new SchemaMigrationRegistry(schema, [{ ...transform, operations: [
      { kind: 'rename_column', table: 'items', from: 'estimate', to: name },
    ] }])).toThrow(/PROTOTYPE_POLLUTION_DETECTED/);
  });

  it('transforms defaults when the target type is unchanged', () => {
    const registry = new SchemaMigrationRegistry(schema, [transform]);
    const engine = new LocalFirstSyncEngine({ nodeId: 'node', registry, initialActiveVersion: 1 });
    engine.upsert('item-1', {}, 100);
    expect(engine.getRow('item-1')?.estimate).toBe(1);
    engine.migrateToVersion(2);
    expect(registry.getSchemaAtVersion(2).columns.find(c => c.name === 'estimate')?.defaultValue).toBe(60);
    expect(engine.getRow('item-1')?.estimate).toBe(60);
  });

  it.skipIf(!hasSqlite)('persists transformed defaults for sparse SQL rows', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const registry = new SchemaMigrationRegistry(schema, [transform]);
    const engine = new LocalFirstSyncEngine({ nodeId: 'node', registry, initialActiveVersion: 1 });
    engine.upsert('item-1', {}, 100);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(compileCreateTableSql(schema, 'sqlite'));
      const adapter = createSqliteAdapter(db);
      await mergeSqlRowState(adapter, registry, engine.getRawRowState('item-1')!);
      await migrateSqlTable(adapter, registry, 1, 2);
      expect(db.prepare('SELECT estimate FROM items').get()?.estimate).toBe(60);
    } finally { db.close(); }
  });
});
