import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sqliteAvailable } from './support/sqlite';
import {
  compileCreateTableSql, createPostgresAdapter, createSqliteAdapter, formatHlc,
  mergeSqlRowState, migrateSqlTable, SchemaMigrationRegistry,
  type CrdtRowState, type SqlDatabaseAdapter, type TableSchema,
} from '../src/engine';

const postgresUrl = process.env.TEST_POSTGRES_URL;
if (process.env.REQUIRE_POSTGRES_TESTS === '1' && !postgresUrl) throw new Error('TEST_POSTGRES_URL is required');
const hlc = formatHlc({ wallTimeMs: 1000, counter: 0, nodeId: 'source' });

type Fixture = { schema: TableSchema; db: SqlDatabaseAdapter; registry: SchemaMigrationRegistry; close(): Promise<void> };
async function fixture(dialect: 'sqlite' | 'postgres'): Promise<Fixture> {
  const schema: TableSchema = { tableName: `Review_${crypto.randomUUID().replace(/-/g, '')}`, version: 1,
    primaryKey: 'id', columns: [{ name: 'id', type: 'TEXT', nullable: false }, { name: 'title', type: 'TEXT', nullable: true }] };
  let db: SqlDatabaseAdapter;
  let close: () => Promise<void>;
  if (dialect === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const connection = new DatabaseSync(':memory:');
    connection.exec(compileCreateTableSql(schema, dialect));
    db = createSqliteAdapter(connection);
    close = async () => { connection.close(); };
  } else {
    const pool = new Pool({ connectionString: postgresUrl });
    await pool.query(compileCreateTableSql(schema, dialect));
    db = createPostgresAdapter(pool);
    close = async () => { await pool.query(`DROP TABLE IF EXISTS "${schema.tableName}"`); await pool.end(); };
  }
  const registry = new SchemaMigrationRegistry(schema, [{ fromVersion: 1, toVersion: 2, description: 'add a column', operations: [
    { kind: 'add_column', table: schema.tableName, column: { name: 'extra', type: 'TEXT', nullable: true } },
  ] }]);
  const row: CrdtRowState = { table: schema.tableName, pk: 'one', schemaVersion: 1, tombstoneHlc: null,
    cells: { id: { value: 'one', hlc }, title: { value: 'preserved', hlc } },
    unmappedFields: { archived: { value: 'history', hlc, sourceVersion: 1 } } };
  await mergeSqlRowState(db, registry, row);
  return { schema, db, registry, close };
}

async function snapshot(f: Fixture) {
  return f.db.withWriteTransaction(async tx => {
    const table = f.schema.tableName;
    const rows = await tx.query(`SELECT * FROM "${table}"`);
    const columns = f.db.dialect === 'sqlite'
      ? await tx.query('SELECT * FROM pragma_table_xinfo(?)', [table])
      : await tx.query('SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position', [table]);
    const indexes = f.db.dialect === 'sqlite'
      ? await tx.query('SELECT name, sql FROM sqlite_master WHERE type = \'index\' AND tbl_name = ? ORDER BY name', [table])
      : await tx.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 ORDER BY indexname', [table]);
    return { rows, columns, indexes };
  });
}

describe.each([
  { dialect: 'sqlite' as const, skip: !sqliteAvailable },
  { dialect: 'postgres' as const, skip: !postgresUrl },
])('$dialect migration failure atomicity', ({ dialect, skip }) => {
  let active: Fixture | undefined;
  afterEach(async () => { await active?.close(); active = undefined; });

  it.skipIf(skip).each(['CREATE', 'DROP', 'RENAME'] as const)('rolls back failure after %s DDL', async stage => {
    active = await fixture(dialect);
    const f = active;
    const before = await snapshot(f);
    const failure = new Error(`failure after ${stage}`);
    let reached = false;
    let migrationTable: string | undefined;
    const failing: SqlDatabaseAdapter = { dialect, async withWriteTransaction(work) {
      return f.db.withWriteTransaction(tx => work({ async query(sql, params) {
        const created = /^CREATE TABLE "(crdt_migration_[a-f0-9]+)"/.exec(sql);
        if (created) migrationTable = created[1];
        const result = await tx.query(sql, params);
        const matches = stage === 'CREATE' ? Boolean(created)
          : stage === 'DROP' ? sql === `DROP TABLE "${f.schema.tableName}";`
          : /^ALTER TABLE "crdt_migration_[a-f0-9]+" RENAME TO /.test(sql);
        if (matches) { reached = true; throw failure; }
        return result;
      } }));
    } };
    await expect(migrateSqlTable(failing, f.registry, 1, 2)).rejects.toBe(failure);
    expect(reached).toBe(true);
    expect(await snapshot(f)).toEqual(before);
    const temporary = await f.db.withWriteTransaction(tx => dialect === 'sqlite'
      ? tx.query('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?', [migrationTable!])
      : tx.query('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1', [migrationTable!]));
    expect(temporary).toEqual([]);
  });

  it.skipIf(skip).each([
    ['invalid cell HLC', '_column_hlcs', JSON.stringify({ id: hlc, title: 'broken-clock' })],
    ['nonobject metadata', '_column_hlcs', JSON.stringify('not an object')],
    ['wrong row version', '_schema_version', 99],
  ] as const)('rejects %s without modifying the original table', async (_name, column, value) => {
    active = await fixture(dialect);
    const f = active;
    await f.db.withWriteTransaction(tx => tx.query(`UPDATE "${f.schema.tableName}" SET "${column}" = ${dialect === 'sqlite' ? '?' : '$1'}`, [value]));
    const before = await snapshot(f);
    await expect(migrateSqlTable(f.db, f.registry, 1, 2)).rejects.toBeDefined();
    expect(await snapshot(f)).toEqual(before);
  });

  it.skipIf(skip)('rejects invalid JSON returned by a driver before rebuilding', async () => {
    active = await fixture(dialect);
    const f = active;
    const before = await snapshot(f);
    const corruptDriver: SqlDatabaseAdapter = { dialect, async withWriteTransaction(work) {
      return f.db.withWriteTransaction(tx => work({ async query(sql, params) {
        const rows = await tx.query(sql, params);
        return sql === `SELECT * FROM "${f.schema.tableName}";` ? rows.map(row => ({ ...row, _column_hlcs: '{' })) : rows;
      } }));
    } };
    await expect(migrateSqlTable(corruptDriver, f.registry, 1, 2)).rejects.toMatchObject({ code: 'MALFORMED_JSON' });
    expect(await snapshot(f)).toEqual(before);
  });

  it.skipIf(skip)('rejects missing causal columns without changing the damaged snapshot', async () => {
    active = await fixture(dialect);
    const f = active;
    await f.db.withWriteTransaction(tx => tx.query(`ALTER TABLE "${f.schema.tableName}" DROP COLUMN "_column_hlcs"`));
    const before = await snapshot(f);
    await expect(migrateSqlTable(f.db, f.registry, 1, 2)).rejects.toMatchObject({ code: 'SQL_SNAPSHOT_REGENERATION_REQUIRED' });
    expect(await snapshot(f)).toEqual(before);
  });

  it.skipIf(skip)('rejects a target version absent from the registry before rebuilding', async () => {
    active = await fixture(dialect);
    const f = active;
    const before = await snapshot(f);
    await expect(migrateSqlTable(f.db, f.registry, 1, 3)).rejects.toMatchObject({ code: 'UNKNOWN_SCHEMA_VERSION' });
    expect(await snapshot(f)).toEqual(before);
  });

  it.skipIf(skip)('preserves custom indexes when dependency checks reject migration', async () => {
    active = await fixture(dialect);
    const f = active;
    await f.db.withWriteTransaction(tx => tx.query(`CREATE INDEX "${f.schema.tableName}_idx" ON "${f.schema.tableName}" (title)`));
    const before = await snapshot(f);
    await expect(migrateSqlTable(f.db, f.registry, 1, 2)).rejects.toMatchObject({ code: 'SQL_MIGRATION_UNSUPPORTED_DEPENDENCY' });
    expect(await snapshot(f)).toEqual(before);
  });
});
