import { compareHlc, parseHlc } from './hlc';
import { isRowTombstoned, mergeCrdtRowStates } from './crdt';
import { SchemaMigrationRegistry } from './migrator';
import { assertSafeScalarValue, assertValidPrimaryKey, createSafeRecord, quoteSqlIdentifier, safeJsonParse, SafetyViolationError } from './safety';
import { compileCreateTableSql, compileParameterizedInsert, defaultZeroForType } from './schema';
import { validateVaultEntry } from './vault';
import type { CrdtCell, CrdtRowState, ScalarValue, SqlDialect, TableSchema, UnmappedVaultEntry } from './types';

export interface SqlTransaction {
  query(sql: string, params?: readonly ScalarValue[]): Promise<readonly Record<string, unknown>[]>;
}

/** A write transaction must serialize writers (SQLite BEGIN IMMEDIATE; PostgreSQL row locks). */
export interface SqlDatabaseAdapter {
  readonly dialect: SqlDialect;
  withWriteTransaction<T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T>;
}

/** Minimal interface implemented by node:sqlite DatabaseSync and compatible drivers. */
export interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: (string | number | null)[]): readonly Record<string, unknown>[] };
}

export function createSqliteAdapter(connection: SqliteConnection): SqlDatabaseAdapter {
  let pending: Promise<void> = Promise.resolve();
  return {
    dialect: 'sqlite',
    async withWriteTransaction<T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      const previous = pending;
      let release!: () => void;
      pending = new Promise<void>(resolve => { release = resolve; });
      await previous;
      let began = false;
      try {
        connection.exec('BEGIN IMMEDIATE');
        began = true;
        const result = await work({ async query(sql, params = []) { return connection.prepare(sql).all(...params.map(value => typeof value === 'boolean' ? Number(value) : value)); } });
        connection.exec('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) connection.exec('ROLLBACK');
        throw error;
      } finally { release(); }
    },
  };
}

/** Minimal pool contract; callers supply a pg Pool or compatible implementation. */
export interface PostgresPool {
  connect(): Promise<{
    query(sql: string, params?: ScalarValue[]): Promise<{ rows: Record<string, unknown>[] }>;
    release(): void;
  }>;
}

export function createPostgresAdapter(pool: PostgresPool): SqlDatabaseAdapter {
  return {
    dialect: 'postgres',
    async withWriteTransaction<T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({ async query(sql, params = []) { return (await client.query(sql, [...params])).rows; } });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
  };
}

function placeholder(dialect: SqlDialect, index: number): string {
  return dialect === 'postgres' ? `$${index}` : '?';
}

async function assertCausalColumns(tx: SqlTransaction, schema: TableSchema, dialect: SqlDialect): Promise<void> {
  const rows = dialect === 'sqlite'
    ? await tx.query('SELECT name FROM pragma_table_xinfo(?)', [schema.tableName])
    : await tx.query('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [schema.tableName]);
  const names = new Set(rows.map(row => String(row.name)));
  if (!['_causal_version', '_tombstone_hlc', '_column_hlcs', '_column_tie_values', '_unmapped_vault'].every(name => names.has(name))) {
    throw new SafetyViolationError('SQL_SNAPSHOT_REGENERATION_REQUIRED', 'Snapshot lacks causal metadata; regenerate it from live CRDT state.');
  }
}

async function assertExactColumns(tx: SqlTransaction, schema: TableSchema, dialect: SqlDialect): Promise<void> {
  const rows = dialect === 'sqlite'
    ? await tx.query('SELECT name FROM pragma_table_xinfo(?)', [schema.tableName])
    : await tx.query('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [schema.tableName]);
  const actual = new Set(rows.map(row => String(row.name)));
  const expected = new Set([...schema.columns.map(col => col.name), '_crdt_hlc', '_column_hlcs', '_column_tie_values', '_tombstone_hlc', '_causal_version', '_schema_version', '_unmapped_vault']);
  if (actual.size !== expected.size || [...expected].some(name => !actual.has(name))) {
    throw new SafetyViolationError('SQL_MIGRATION_UNSUPPORTED_DEPENDENCY', 'Tables with extra or missing columns require a custom migration.');
  }
}

function metadata<T>(value: unknown, name: string): T {
  if (value === undefined || value === null) {
    throw new SafetyViolationError('SQL_SNAPSHOT_REGENERATION_REQUIRED', `Missing ${name}; regenerate legacy SQL snapshots.`);
  }
  return safeJsonParse<T>(typeof value === 'string' ? value : JSON.stringify(value));
}

function parseSqlRow(schema: TableSchema, row: Record<string, unknown>): CrdtRowState {
  if (Number(row._causal_version) !== 2 || !Object.hasOwn(row, '_tombstone_hlc')) {
    throw new SafetyViolationError('SQL_SNAPSHOT_REGENERATION_REQUIRED', 'Snapshot lacks causal metadata; regenerate it from live CRDT state.');
  }
  if (Number(row._schema_version) !== schema.version) {
    throw new SafetyViolationError('SQL_SCHEMA_VERSION_MISMATCH', 'SQL row schema version does not match the registry.');
  }
  const rawPk = row[schema.primaryKey];
  if (typeof rawPk !== 'string') throw new SafetyViolationError('INVALID_PRIMARY_KEY', 'SQL row primary key must be a string.');
  const pk = assertValidPrimaryKey(rawPk);
  const clocks = metadata<Record<string, string>>(row._column_hlcs, '_column_hlcs');
  const tieValues = metadata<Record<string, ScalarValue>>(row._column_tie_values, '_column_tie_values');
  const vault = metadata<Record<string, UnmappedVaultEntry>>(row._unmapped_vault, '_unmapped_vault');
  if (typeof clocks !== 'object' || clocks === null || Array.isArray(clocks) ||
      typeof tieValues !== 'object' || tieValues === null || Array.isArray(tieValues) ||
      typeof vault !== 'object' || vault === null || Array.isArray(vault)) {
    throw new SafetyViolationError('INVALID_SQL_METADATA', 'SQL clocks and vault must be JSON objects.');
  }
  for (const [name, entry] of Object.entries(vault)) validateVaultEntry(entry, name);
  for (const name of Object.keys(clocks)) {
    if (!schema.columns.some(col => col.name === name)) throw new SafetyViolationError('INVALID_SQL_CLOCKS', `Unknown clock column ${name}.`);
  }
  for (const name of Object.keys(tieValues)) {
    if (!Object.hasOwn(clocks, name)) throw new SafetyViolationError('INVALID_SQL_CLOCKS', `Tie value without a cell clock: ${name}.`);
    assertSafeScalarValue(tieValues[name], name);
  }
  const cells = createSafeRecord<CrdtCell>();
  for (const col of schema.columns) {
    if (!Object.hasOwn(clocks, col.name)) continue;
    const hlc = clocks[col.name]!;
    parseHlc(hlc);
    let value = row[col.name];
    if (col.type === 'BOOLEAN' && typeof value === 'number') value = Boolean(value);
    if ((col.type === 'INTEGER' || col.type === 'REAL') && typeof value === 'string') value = Number(value);
    cells[col.name] = { value: assertSafeScalarValue(value, col.name, col.type, col.nullable), hlc,
      ...(Object.hasOwn(tieValues, col.name) ? { tieValue: tieValues[col.name]! } : {}) };
  }
  const tombstoneHlc = row._tombstone_hlc === null ? null : String(row._tombstone_hlc);
  if (tombstoneHlc !== null) parseHlc(tombstoneHlc);
  return { table: schema.tableName, pk, schemaVersion: schema.version, cells, unmappedFields: vault, tombstoneHlc };
}

function maxClock(row: CrdtRowState): string {
  const clocks = Object.values(row.cells).map((cell) => cell.hlc);
  const visit = (entry: UnmappedVaultEntry): void => {
    clocks.push(entry.hlc);
    for (const alternative of entry.alternatives ?? []) visit(alternative);
  };
  Object.values(row.unmappedFields).forEach(visit);
  if (row.tombstoneHlc !== null) clocks.push(row.tombstoneHlc);
  if (!clocks.length) throw new SafetyViolationError('EMPTY_CRDT_ROW', 'SQL persistence requires at least one row clock.');
  return clocks.reduce((latest, hlc) => compareHlc(hlc, latest) > 0 ? hlc : latest);
}

function rowValues(schema: TableSchema, row: CrdtRowState): Record<string, ScalarValue> {
  const values = createSafeRecord<ScalarValue>();
  for (const col of schema.columns) {
    values[col.name] = row.cells[col.name]?.value ?? (col.name === schema.primaryKey ? row.pk : col.defaultValue ?? (col.nullable ? null : defaultZeroForType(col.type)));
    if (row.cells[col.name]?.value === null) values[col.name] = null;
  }
  return values;
}

function rowInsert(schema: TableSchema, row: CrdtRowState, dialect: SqlDialect) {
  return compileParameterizedInsert(schema, rowValues(schema, row), maxClock(row), JSON.stringify(row.unmappedFields), dialect,
    JSON.stringify(Object.fromEntries(Object.entries(row.cells).map(([name, cell]) => [name, cell.hlc]))), row.tombstoneHlc,
    JSON.stringify(Object.fromEntries(Object.entries(row.cells).filter(([, cell]) => Object.hasOwn(cell, 'tieValue')).map(([name, cell]) => [name, cell.tieValue]))));
}

async function insertRow(tx: SqlTransaction, schema: TableSchema, row: CrdtRowState, dialect: SqlDialect): Promise<void> {
  const query = rowInsert(schema, row, dialect);
  await tx.query(query.sql, query.params);
}

async function updateRow(tx: SqlTransaction, schema: TableSchema, row: CrdtRowState, dialect: SqlDialect): Promise<void> {
  const query = rowInsert(schema, row, dialect);
  const pk = quoteSqlIdentifier(schema.primaryKey, 'primary key');
  // This overwrite is safe only because the row was read and merged while locked.
  const match = query.sql.indexOf('ON CONFLICT');
  const insert = query.sql.slice(0, match);
  const names = [...schema.columns.map(c => c.name), '_crdt_hlc', '_column_hlcs', '_column_tie_values', '_tombstone_hlc', '_causal_version', '_schema_version', '_unmapped_vault'];
  const assignments = names.filter(n => n !== schema.primaryKey).map(n => {
    const id = quoteSqlIdentifier(n, 'column');
    return `${id} = EXCLUDED.${id}`;
  });
  await tx.query(`${insert}ON CONFLICT (${pk}) DO UPDATE SET ${assignments.join(', ')};`, query.params);
}

/** Atomically merge a full CRDT row, retaining tombstones and distinct field clocks. */
export async function mergeSqlRowState(db: SqlDatabaseAdapter, registry: SchemaMigrationRegistry, incoming: CrdtRowState): Promise<CrdtRowState> {
  const schema = registry.getSchemaAtVersion(incoming.schemaVersion);
  if (incoming.table !== schema.tableName) throw new SafetyViolationError('TABLE_MISMATCH', 'Row table does not match SQL schema.');
  assertValidPrimaryKey(incoming.pk);
  for (const [name, cell] of Object.entries(incoming.cells)) {
    const column = schema.columns.find(col => col.name === name);
    if (!column) throw new SafetyViolationError('UNKNOWN_COLUMN_FOR_SCHEMA_VERSION', `Unknown SQL row column ${name}.`);
    if (name === schema.primaryKey && cell.value !== incoming.pk) throw new SafetyViolationError('PRIMARY_KEY_MISMATCH', 'Row primary key does not match its primary-key cell.');
    parseHlc(cell.hlc);
    assertSafeScalarValue(cell.value, name, column.type, column.nullable);
    if (Object.hasOwn(cell, 'tieValue')) assertSafeScalarValue(cell.tieValue, name);
  }
  if (incoming.tombstoneHlc !== null) parseHlc(incoming.tombstoneHlc);
  for (const [name, entry] of Object.entries(incoming.unmappedFields)) validateVaultEntry(entry, name);
  return db.withWriteTransaction(async tx => {
    await assertCausalColumns(tx, schema, db.dialect);
    await insertRow(tx, schema, incoming, db.dialect);
    const table = quoteSqlIdentifier(schema.tableName, 'table');
    const pk = quoteSqlIdentifier(schema.primaryKey, 'primary key');
    const lock = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const found = await tx.query(`SELECT * FROM ${table} WHERE ${pk} = ${placeholder(db.dialect, 1)}${lock};`, [incoming.pk]);
    if (found.length !== 1) throw new SafetyViolationError('SQL_ROW_NOT_FOUND', 'Inserted row could not be locked.');
    const current = parseSqlRow(schema, found[0]!);
    const merged = mergeCrdtRowStates(current, incoming);
    await updateRow(tx, schema, merged, db.dialect);
    return merged;
  });
}

/** Reads live rows while retaining deleted rows and their tombstones in the database. */
export async function listLiveSqlRows(db: SqlDatabaseAdapter, schema: TableSchema): Promise<readonly CrdtRowState[]> {
  return db.withWriteTransaction(async tx => {
    await assertCausalColumns(tx, schema, db.dialect);
    const rows = await tx.query(`SELECT * FROM ${quoteSqlIdentifier(schema.tableName, 'table')};`);
    return rows.map(row => parseSqlRow(schema, row)).filter(row => !isRowTombstoned(row)).sort((a, b) => a.pk < b.pk ? -1 : a.pk > b.pk ? 1 : 0);
  });
}

/** Execute a migration by upcasting row state and rebuilding the engine-managed table atomically. */
export async function migrateSqlTable(db: SqlDatabaseAdapter, registry: SchemaMigrationRegistry, fromVersion: number, toVersion: number): Promise<void> {
  const source = registry.getSchemaAtVersion(fromVersion);
  const target = registry.getSchemaAtVersion(toVersion);
  registry.getStepsBetween(fromVersion, toVersion);
  if (fromVersion === toVersion) return;
  await db.withWriteTransaction(async tx => {
    await assertCausalColumns(tx, source, db.dialect);
    await assertExactColumns(tx, source, db.dialect);
    const table = quoteSqlIdentifier(source.tableName, 'table');
    if (db.dialect === 'postgres') await tx.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE;`);
    // Rebuilds must not silently discard application indexes, triggers or foreign keys.
    if (db.dialect === 'sqlite') {
      const objects = await tx.query("SELECT name FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL", [source.tableName]);
      const declared = await tx.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [source.tableName]);
      const declaredSql = String(declared[0]?.sql ?? '');
      const automaticIndexes = await tx.query('SELECT origin FROM pragma_index_list(?)', [source.tableName]);
      const tables = await tx.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
      if (objects.length || automaticIndexes.some(index => index.origin !== 'pk') || /\b(CHECK|COLLATE|GENERATED|REFERENCES|UNIQUE|STRICT|WITHOUT\s+ROWID)\b/i.test(declaredSql)) throw new SafetyViolationError('SQL_MIGRATION_UNSUPPORTED_DEPENDENCY', 'Custom table constraints, indexes, and triggers require a custom migration.');
      for (const item of tables) {
        const name = String(item.name);
        const foreign = await tx.query('SELECT "table" FROM pragma_foreign_key_list(?)', [name]);
        if ((name === source.tableName && foreign.length) || foreign.some(f => f.table === source.tableName)) {
          throw new SafetyViolationError('SQL_MIGRATION_UNSUPPORTED_DEPENDENCY', 'Foreign keys require a custom migration.');
        }
      }
      const views = await tx.query("SELECT name FROM sqlite_master WHERE type = 'view'");
      if (views.length) throw new SafetyViolationError('SQL_MIGRATION_UNSUPPORTED_DEPENDENCY', 'Views require a custom migration.');
    } else {
      // to_regclass parses SQL identifiers; pass the quoted name so mixed-case
      // names cannot bypass the dependency/security checks.
      const relationRef = quoteSqlIdentifier(source.tableName, 'table');
      const constraints = await tx.query("SELECT 1 FROM pg_constraint WHERE (conrelid = to_regclass($1) OR confrelid = to_regclass($1)) AND contype NOT IN ('p', 'n') LIMIT 1", [relationRef]);
      const indexes = await tx.query('SELECT 1 FROM pg_index WHERE indrelid = to_regclass($1) AND NOT indisprimary LIMIT 1', [relationRef]);
      const triggers = await tx.query('SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass($1) AND NOT tgisinternal LIMIT 1', [relationRef]);
      const properties = await tx.query("SELECT 1 FROM pg_class c WHERE c.oid = to_regclass($1) AND (c.relacl IS NOT NULL OR pg_get_userbyid(c.relowner) <> current_user OR c.relrowsecurity OR c.relforcerowsecurity OR c.relhasrules OR c.relpersistence <> 'p' OR c.relkind <> 'r' OR c.relispartition OR c.relreplident <> 'd' OR c.reloptions IS NOT NULL OR c.reltablespace <> 0 OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL) OR EXISTS (SELECT 1 FROM pg_description d WHERE d.objoid = c.oid) OR EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) OR EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid OR i.inhparent = c.oid) OR EXISTS (SELECT 1 FROM pg_statistic_ext s WHERE s.stxrelid = c.oid) OR EXISTS (SELECT 1 FROM pg_publication_rel p WHERE p.prrelid = c.oid))", [relationRef]);
      if (constraints.length || indexes.length || triggers.length || properties.length) throw new SafetyViolationError('SQL_MIGRATION_UNSUPPORTED_DEPENDENCY', 'Table permissions, policies, or dependencies require a custom migration.');
    }
    const existing = await tx.query(`SELECT * FROM ${table};`);
    const migrated = existing.map(row => registry.upcastRowState(parseSqlRow(source, row), toVersion).row);
    const suffix = globalThis.crypto.randomUUID().replace(/-/g, '');
    const tempName = `crdt_migration_${suffix}`;
    const tempSchema = { ...target, tableName: tempName };
    const create = compileCreateTableSql(tempSchema, db.dialect).replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE');
    await tx.query(create);
    for (const row of migrated) await insertRow(tx, tempSchema, { ...row, table: tempName }, db.dialect);
    await tx.query(`DROP TABLE ${table};`);
    await tx.query(`ALTER TABLE ${quoteSqlIdentifier(tempName, 'table')} RENAME TO ${table};`);
  });
}
