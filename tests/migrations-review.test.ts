import { describe, expect, it } from 'vitest';
import {
  compileCreateTableSql, compileParameterizedUpsert, formatHlc,
  LocalFirstSyncEngine, SchemaMigrationRegistry, validateTableSchema,
  type MigrationStep, type SqlMigrationPlanStep, type TableSchema,
} from '../src/engine';

const schema: TableSchema = {
  tableName: 'items', version: 1, primaryKey: 'id', columns: [
    {name: 'id', type: 'TEXT', nullable: false},
    {name: 'original', type: 'TEXT', nullable: false},
    {name: 'flag', type: 'BOOLEAN', nullable: true},
    {name: 'document', type: 'JSON', nullable: true},
  ],
};
const step: MigrationStep = { fromVersion: 1, toVersion: 2, description: 'metadata', operations: [
  {kind: 'add_column', table: 'items', column: {name: 'copy', type: 'TEXT', nullable: false, defaultValue: 'default'}, backfillFromColumn: 'original'},
  {kind: 'add_column', table: 'items', column: {name: 'restored', type: 'TEXT', nullable: true}},
  {kind: 'rename_column', table: 'items', from: 'original', to: 'renamed'},
  {kind: 'drop_column_to_vault', table: 'items', column: 'flag'},
  {kind: 'drop_column_to_vault', table: 'items', column: 'document'},
]};
const hlc = (time: number) => formatHlc({wallTimeMs: time, counter: 0, nodeId: 'node'});

describe('SQL migration metadata', () => {
  it.each(['_crdt_hlc', '_column_hlcs', '_schema_version', '_unmapped_vault', '_COLUMN_HLCS'])('reserves %s', name => {
    expect(() => validateTableSchema({...schema, columns: [...schema.columns, {name, type: 'TEXT', nullable: true}]})).toThrow(/RESERVED_METADATA_COLUMN/);
  });

  it.skipIf(Number(process.versions.node.split('.')[0]) < 22)('executes sqlite backfill, restore, rename and lossless archive with column clocks', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const registry = new SchemaMigrationRegistry(schema, [step]);
    const db = new DatabaseSync(':memory:');
    db.exec(compileCreateTableSql(schema, 'sqlite'));
    const cells = {id: hlc(1), original: hlc(2), flag: hlc(3), document: hlc(4)};
    const vault = {restored: {value: 'from vault', hlc: hlc(8), sourceVersion: 3}, flag: {value: false, hlc: hlc(9), sourceVersion: 4}};
    const query = compileParameterizedUpsert(schema, {id: '1', original: 'source', flag: true, document: '{ "a": 1 }'}, hlc(4), JSON.stringify(vault), 'sqlite', JSON.stringify(cells));
    db.prepare(query.sql).run(...(query.params as readonly (string | number | null)[]));
    for (const part of registry.compileMigrationPlan(1, 2, 'sqlite')) {
      expect(part.kind).toBe('sql');
      if (part.kind === 'sql') db.exec(part.statement);
    }
    const row = db.prepare('SELECT * FROM items').get()!;
    expect(row.copy).toBe('source');
    expect(row.renamed).toBe('source');
    expect(row.restored).toBe('from vault');
    expect(row._schema_version).toBe(2);
    expect(row._crdt_hlc).toBe(hlc(8));
    expect(JSON.parse(String(row._column_hlcs))).toEqual({id: hlc(1), copy: hlc(2), renamed: hlc(2), restored: hlc(8)});
    expect(JSON.parse(String(row._unmapped_vault))).toEqual({
      flag: {value: false, hlc: hlc(9), sourceVersion: 4},
      document: {value: '{ "a": 1 }', hlc: hlc(4), sourceVersion: 1},
    });
    db.close();
  });

  it.skipIf(Number(process.versions.node.split('.')[0]) < 22)('archives a SQLite boolean as a boolean, including null', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const registry = new SchemaMigrationRegistry(schema, [{...step, operations: [{kind: 'drop_column_to_vault', table: 'items', column: 'flag'}]}]);
    const db = new DatabaseSync(':memory:');
    db.exec(compileCreateTableSql(schema, 'sqlite'));
    for (const [id, flag] of [['1', true], ['2', null]] as const) {
      const q = compileParameterizedUpsert(schema, {id, original: 'x', flag, document: null}, hlc(3), '{}', 'sqlite', JSON.stringify({id: hlc(1), original: hlc(2), flag: hlc(3)}));
      db.prepare(q.sql).run(...(q.params as readonly (string | number | null)[]));
    }
    for (const part of registry.compileMigrationPlan(1, 2, 'sqlite')) if (part.kind === 'sql') db.exec(part.statement);
    const rows = db.prepare('SELECT "_unmapped_vault" FROM items ORDER BY id').all();
    expect(JSON.parse(String(rows[0]!._unmapped_vault)).flag.value).toBe(true);
    expect(JSON.parse(String(rows[1]!._unmapped_vault)).flag.value).toBe(null);
    db.close();
  });

  it.skipIf(Number(process.versions.node.split('.')[0]) < 22)('reconciles known vault fields against existing and missing cells', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const registry = new SchemaMigrationRegistry(schema, [{fromVersion: 1, toVersion: 2, description: 'reconcile', operations: []}]);
    const db = new DatabaseSync(':memory:');
    db.exec(compileCreateTableSql(schema, 'sqlite'));
    const vault = {
      original: {value: 'vault wins', hlc: hlc(5), sourceVersion: 2},
      flag: {value: false, hlc: hlc(2), sourceVersion: 2},
      document: {value: '{ "new": true }', hlc: hlc(6), sourceVersion: 2},
    };
    const query = compileParameterizedUpsert(schema, {id: '1', original: 'old', flag: true, document: null}, hlc(3), JSON.stringify(vault), 'sqlite', JSON.stringify({id: hlc(1), original: hlc(2), flag: hlc(3)}));
    db.prepare(query.sql).run(...(query.params as readonly (string | number | null)[]));
    for (const part of registry.compileMigrationPlan(1, 2, 'sqlite')) if (part.kind === 'sql') db.exec(part.statement);
    const row = db.prepare('SELECT * FROM items').get()!;
    expect(row.original).toBe('vault wins');
    expect(row.flag).toBe(1);
    expect(row.document).toBe('{ "new": true }');
    expect(row._crdt_hlc).toBe(hlc(6));
    expect(JSON.parse(String(row._unmapped_vault))).toEqual({});
    expect(JSON.parse(String(row._column_hlcs))).toEqual({id: hlc(1), original: hlc(5), flag: hlc(3), document: hlc(6)});
    db.close();
  });

  it('provides the intermediate schema to a transform following a rename', () => {
    const registry = new SchemaMigrationRegistry(schema, [{fromVersion: 1, toVersion: 2, description: 'rename then transform', operations: [
      {kind: 'rename_column', table: 'items', from: 'original', to: 'renamed'},
      {kind: 'transform_column', table: 'items', column: 'renamed', fnName: 'length', targetType: 'INTEGER', transform: value => String(value).length},
    ]}]);
    const app = registry.compileMigrationPlan(1, 2, 'sqlite').find((p): p is Extract<SqlMigrationPlanStep, {kind: 'application_transform'}> => p.kind === 'application_transform')!;
    expect(app.sourceSchema.columns.find(c => c.name === 'renamed')?.type).toBe('TEXT');
    expect(app.targetSchema.columns.find(c => c.name === 'renamed')?.type).toBe('INTEGER');
    expect(app.sourceSchema.columns.some(c => c.name === 'original')).toBe(false);
  });

  it.each(['sqlite', 'postgres'] as const)('exposes application transforms in the %s plan', dialect => {
    const transform: MigrationStep = {fromVersion: 1, toVersion: 2, description: 'transform', operations: [
      {kind: 'transform_column', table: 'items', column: 'original', fnName: 'length', targetType: 'INTEGER', transform: value => String(value).length},
    ]};
    const registry = new SchemaMigrationRegistry(schema, [transform]);
    const plan = registry.compileMigrationPlan(1, 2, dialect);
    const app = plan.find((p): p is Extract<SqlMigrationPlanStep, {kind: 'application_transform'}> => p.kind === 'application_transform');
    expect(app?.operation.targetType).toBe('INTEGER');
    expect(app?.sourceSchema.columns.find(c => c.name === 'original')?.type).toBe('TEXT');
    expect(app?.targetSchema.columns.find(c => c.name === 'original')?.type).toBe('INTEGER');
  });

  it('applies value-only transforms identically to full rows and sparse operations', () => {
    const transform: MigrationStep = {fromVersion: 1, toVersion: 2, description: 'transform', operations: [
      {kind: 'transform_column', table: 'items', column: 'original', fnName: 'double', transform: v => String(v) + String(v)},
    ]};
    const registry = new SchemaMigrationRegistry(schema, [transform]);
    const engine = new LocalFirstSyncEngine({nodeId: 'node', registry, initialActiveVersion: 1});
    const op = engine.upsert('1', {original: 'x'}, 1);
    const normalized = registry.normalizeChangeOperation(op, 2).operation;
    engine.migrateToVersion(2);
    expect(normalized.columns.original?.value).toBe('xx');
    expect(engine.getRawRowState('1')?.cells.original?.value).toBe('xx');
  });

  it.skipIf(Number(process.versions.node.split('.')[0]) < 22)('uses the default when a backfill source is absent from the schema', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const migration: MigrationStep = {fromVersion: 1, toVersion: 2, description: 'missing backfill source', operations: [
      {kind: 'add_column', table: 'items', column: {name: 'copy', type: 'TEXT', nullable: false, defaultValue: 'fallback'}, backfillFromColumn: 'missing_source'},
    ]};
    const registry = new SchemaMigrationRegistry(schema, [migration]);
    const engine = new LocalFirstSyncEngine({nodeId: 'node', registry, initialActiveVersion: 1});
    engine.upsert('1', {original: 'value'}, 1);
    const snapshot = engine.exportSqlSnapshot('sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(snapshot.ddl);
    for (const query of snapshot.upserts) db.prepare(query.sql).run(...(query.params as readonly (string | number | null)[]));
    for (const part of registry.compileMigrationPlan(1, 2, 'sqlite')) {
      if (part.kind === 'sql') db.exec(part.statement);
    }
    engine.migrateToVersion(2);
    expect(db.prepare('SELECT copy FROM items').get()?.copy).toBe(engine.getRow('1')?.copy);
    expect(engine.getRow('1')?.copy).toBe('fallback');
    db.close();
  });
});
