import { describe, expect, it, vi } from 'vitest';
import {
  compileCreateTableSql, createPostgresAdapter, createSqliteAdapter, formatHlc,
  listLiveSqlRows, mergeSqlRowState, migrateSqlTable, SchemaMigrationRegistry,
  type CrdtRowState, type TableSchema,
} from '../src/engine';
import { flattenVaultEntry } from '../src/engine/vault';

let sqliteAvailable = false;
try {
  await import('node:sqlite');
  sqliteAvailable = true;
} catch { /* node:sqlite is unavailable on older supported Node releases */ }

const schema: TableSchema = {
  tableName: 'Items', version: 1, primaryKey: 'id', columns: [
    { name: 'id', type: 'TEXT', nullable: false },
    { name: 'title', type: 'TEXT', nullable: true },
  ],
};
const clock = (time: number) => formatHlc({ wallTimeMs: time, counter: 0, nodeId: 'source' });
const row: CrdtRowState = { table: 'Items', pk: 'one', schemaVersion: 1, tombstoneHlc: null,
  cells: { id: { value: 'one', hlc: clock(1) }, title: { value: 'data', hlc: clock(2) } }, unmappedFields: {} };

async function sqliteFixture() {
  const { DatabaseSync } = await import('node:sqlite');
  const connection = new DatabaseSync(':memory:');
  connection.exec(compileCreateTableSql(schema, 'sqlite'));
  const db = createSqliteAdapter(connection);
  const registry = new SchemaMigrationRegistry(schema, [{
    fromVersion: 1, toVersion: 2, description: 'add a column', operations: [
      { kind: 'add_column', table: schema.tableName, column: { name: 'extra', type: 'TEXT', nullable: true } },
    ],
  }]);
  await mergeSqlRowState(db, registry, row);
  return { connection, db, registry };
}

describe.skipIf(!sqliteAvailable)('SQLite view dependency checks', () => {
  it('migrates with unrelated views and names appearing in literals, comments, and CTEs', async () => {
    const { connection, db, registry } = await sqliteFixture();
    try {
      connection.exec("CREATE TABLE other (id TEXT); CREATE VIEW unrelated AS WITH Items AS (SELECT 'Items' AS value FROM other) SELECT value FROM Items /* Items */; CREATE TEMP VIEW temp_unrelated AS SELECT * FROM other");
      await migrateSqlTable(db, registry, 1, 2);
      expect((await listLiveSqlRows(db, registry.getSchemaAtVersion(2)))[0]?.cells.title?.value).toBe('data');
      expect(connection.prepare('SELECT * FROM unrelated').all()).toEqual([]);
      expect(connection.prepare('SELECT * FROM temp_unrelated').all()).toEqual([]);
    } finally { connection.close(); }
  });

  it.each([
    ['quoted name', 'CREATE VIEW dependent AS SELECT * FROM "Items"'],
    ['case-insensitive name', 'CREATE VIEW dependent AS SELECT * FROM items'],
    ['qualified name', 'CREATE VIEW dependent AS SELECT * FROM main."Items"'],
    ['indirect view', 'CREATE VIEW direct AS SELECT * FROM "Items"; CREATE VIEW dependent AS SELECT * FROM direct'],
    ['temporary view', 'CREATE TEMP VIEW dependent AS SELECT * FROM main."Items"'],
  ])('rejects a %s and restores the schema and rows', async (_name, createView) => {
    const { connection, db, registry } = await sqliteFixture();
    try {
      connection.exec(createView);
      const before = connection.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all();
      await expect(migrateSqlTable(db, registry, 1, 2)).rejects.toMatchObject({ code: 'SQL_MIGRATION_UNSUPPORTED_DEPENDENCY' });
      expect(connection.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all()).toEqual(before);
      expect(await listLiveSqlRows(db, schema)).toEqual([row]);
      expect(connection.prepare('SELECT * FROM dependent').all()).toHaveLength(1);
    } finally { connection.close(); }
  });

  it('fails safely when a malformed view prevents dependency analysis', async () => {
    const { connection, db, registry } = await sqliteFixture();
    try {
      connection.exec('CREATE VIEW malformed AS SELECT * FROM missing_table');
      await expect(migrateSqlTable(db, registry, 1, 2)).rejects.toMatchObject({ code: 'SQL_MIGRATION_UNSUPPORTED_DEPENDENCY' });
      expect(await listLiveSqlRows(db, schema)).toEqual([row]);
    } finally { connection.close(); }
  });

  it('fails safely when legacy alter-table behavior is enabled', async () => {
    const { connection, db, registry } = await sqliteFixture();
    try {
      connection.exec('CREATE TABLE other (id TEXT); CREATE VIEW unrelated AS SELECT * FROM other; PRAGMA legacy_alter_table=ON');
      await expect(migrateSqlTable(db, registry, 1, 2)).rejects.toMatchObject({ code: 'SQL_MIGRATION_UNSUPPORTED_DEPENDENCY' });
      expect(await listLiveSqlRows(db, schema)).toEqual([row]);
    } finally { connection.close(); }
  });

  it('preserves multiple ambiguous legacy vault values through SQL persistence', async () => {
    const { connection, db, registry } = await sqliteFixture();
    try {
      const incoming = { ...row, unmappedFields: { old: { value: 'first', hlc: clock(3), sourceVersion: 2,
        alternatives: [{ value: 'second', hlc: clock(4), sourceVersion: 2 }] } } };
      await mergeSqlRowState(db, registry, incoming);
      const [saved] = await listLiveSqlRows(db, schema);
      expect(flattenVaultEntry(saved!.unmappedFields.old!).map(entry => entry.value).sort()).toEqual(['first', 'second']);
    } finally { connection.close(); }
  });
});

describe('PostgreSQL transaction cleanup', () => {
  it('keeps the original error and discards the connection if rollback fails', async () => {
    const original = new Error('application work failed');
    const rollbackFailure = new Error('connection lost during rollback');
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') throw rollbackFailure;
      return { rows: [] };
    });
    const db = createPostgresAdapter({ connect: async () => ({ query, release }) });
    await expect(db.withWriteTransaction(async () => { throw original; })).rejects.toBe(original);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenCalledWith(rollbackFailure);
  });

  it('releases a healthy connection normally after successful rollback and commit', async () => {
    const release = vi.fn();
    const query = vi.fn(async () => ({ rows: [] }));
    const db = createPostgresAdapter({ connect: async () => ({ query, release }) });
    await expect(db.withWriteTransaction(async () => { throw new Error('application failure'); })).rejects.toThrow('application failure');
    expect(release).toHaveBeenLastCalledWith(undefined);
    await expect(db.withWriteTransaction(async () => 'ok')).resolves.toBe('ok');
    expect(release).toHaveBeenLastCalledWith(undefined);
  });
});
