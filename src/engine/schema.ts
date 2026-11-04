import {
  assertSafeScalarValue,
  assertValidSqlIdentifier,
  quoteSqlIdentifier,
  SafetyViolationError,
} from './safety';
import type {
  ColumnDataType,
  ColumnSpec,
  MigrationOperation,
  ScalarValue,
  SqlDialect,
  SqlMigrationPlanStep,
  TableSchema,
} from './types';

export function validateTableSchema(schema: TableSchema): TableSchema {
  assertValidSqlIdentifier(schema.tableName, 'table name');
  assertValidSqlIdentifier(schema.primaryKey, 'primary key');

  if (!Number.isSafeInteger(schema.version) || schema.version < 1) {
    throw new SafetyViolationError(
      'INVALID_SCHEMA_VERSION',
      `Schema version must be a positive integer, got ${String(schema.version)}.`
    );
  }

  if (!Array.isArray(schema.columns) || schema.columns.length === 0) {
    throw new SafetyViolationError(
      'EMPTY_TABLE_COLUMNS',
      `Table "${schema.tableName}" must define at least one column.`
    );
  }

  const seenColumns = new Set<string>();
  let pkFound = false;

  for (const col of schema.columns) {
    assertValidSqlIdentifier(col.name, 'column name');
    if (['_crdt_hlc', '_column_hlcs', '_schema_version', '_unmapped_vault'].includes(col.name.toLowerCase())) {
      throw new SafetyViolationError('RESERVED_METADATA_COLUMN', `Column "${col.name}" is reserved for CRDT metadata.`);
    }
    if (seenColumns.has(col.name.toLowerCase())) {
      throw new SafetyViolationError(
        'DUPLICATE_COLUMN',
        `Duplicate column "${col.name}" in table "${schema.tableName}".`
      );
    }
    seenColumns.add(col.name.toLowerCase());

    if (col.name === schema.primaryKey) {
      pkFound = true;
      if (col.nullable) {
        throw new SafetyViolationError(
          'NULLABLE_PRIMARY_KEY',
          `Primary key column "${col.name}" in "${schema.tableName}" cannot be nullable.`
        );
      }
    }

    if (col.defaultValue !== undefined) {
      assertSafeScalarValue(col.defaultValue, col.name, col.type, col.nullable);
    }
  }

  if (!pkFound) {
    throw new SafetyViolationError(
      'MISSING_PRIMARY_KEY_COLUMN',
      `Primary key "${schema.primaryKey}" is not present in columns of table "${schema.tableName}".`
    );
  }

  return schema;
}

function mapSqlType(type: ColumnDataType, dialect: SqlDialect): string {
  switch (type) {
    case 'TEXT':
      return 'TEXT';
    case 'INTEGER':
      return dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
    case 'REAL':
      return dialect === 'postgres' ? 'DOUBLE PRECISION' : 'REAL';
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'JSON':
      // ScalarValue stores JSON as a string; TEXT preserves its exact representation.
      return 'TEXT';
  }
}

function formatSqlLiteral(value: ScalarValue, type: ColumnDataType, dialect: SqlDialect): string {
  assertSafeScalarValue(value, 'default_literal', type, true);
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    if (dialect === 'sqlite') {
      return value ? '1' : '0';
    }
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SafetyViolationError('NON_FINITE_NUMBER', 'Cannot format non-finite SQL literal.');
    }
    return String(value);
  }
  const escaped = value.replace(/'/g, "''");
  return `'${escaped}'`;
}

export function compileCreateTableSql(schema: TableSchema, dialect: SqlDialect): string {
  validateTableSchema(schema);
  const tableIdent = quoteSqlIdentifier(schema.tableName, 'table');

  const colDefs = schema.columns.map((col) => {
    const colIdent = quoteSqlIdentifier(col.name, 'column');
    const sqlType = mapSqlType(col.type, dialect);
    const pkClause = col.name === schema.primaryKey ? ' PRIMARY KEY' : '';
    const nullClause = !col.nullable && col.name !== schema.primaryKey ? ' NOT NULL' : '';
    const defaultClause =
      col.defaultValue !== undefined
        ? ` DEFAULT ${formatSqlLiteral(col.defaultValue, col.type, dialect)}`
        : '';
    return `  ${colIdent} ${sqlType}${pkClause}${nullClause}${defaultClause}`;
  });

  // Sidecar metadata columns for local-first CRDT + forward-compatibility vault
  const metaJsonType = dialect === 'postgres' ? 'JSONB' : 'TEXT';
  colDefs.push(`  "_crdt_hlc" TEXT NOT NULL`);
  colDefs.push(`  "_column_hlcs" ${metaJsonType} NOT NULL`);
  colDefs.push(`  "_schema_version" INTEGER NOT NULL DEFAULT ${schema.version}`);
  colDefs.push(`  "_unmapped_vault" ${metaJsonType} NOT NULL DEFAULT '{}'`);

  return `CREATE TABLE IF NOT EXISTS ${tableIdent} (\n${colDefs.join(',\n')}\n);`;
}

function normalizedSqlHlc(value: string, dialect: SqlDialect): string {
  return dialect === 'postgres'
    ? `(upper(substring(${value} from 1 for 20)) || substring(${value} from 21)) COLLATE "C"`
    : `(upper(substr(${value}, 1, 20)) || substr(${value}, 21)) COLLATE BINARY`;
}

/** Reconcile vault entries for all columns in the target schema. */
export function compileVaultRestorationPlan(schema: TableSchema, dialect: SqlDialect): readonly SqlMigrationPlanStep[] {
  const table = quoteSqlIdentifier(schema.tableName, 'table');
  const pg = dialect === 'postgres';
  return schema.columns.map(col => {
    const name = assertValidSqlIdentifier(col.name, 'column');
    const column = quoteSqlIdentifier(name, 'column');
    const entry = pg ? `"_unmapped_vault" -> '${name}'` : `json_extract("_unmapped_vault", '$.${name}')`;
    const clock = pg ? `(${entry}) ->> 'hlc'` : `json_extract(${entry}, '$.hlc')`;
    const value = pg ? `((${entry}) ->> 'value')::${mapSqlType(col.type, dialect)}` : `json_extract(${entry}, '$.value')`;
    const exists = pg ? `"_unmapped_vault" ? '${name}'` : `json_type("_unmapped_vault", '$.${name}') IS NOT NULL`;
    const hasClock = pg ? `"_column_hlcs" ? '${name}'` : `json_type("_column_hlcs", '$.${name}') IS NOT NULL`;
    const setClock = pg ? `jsonb_set("_column_hlcs", '{${name}}', to_jsonb(${clock}), true)` : `json_set("_column_hlcs", '$.${name}', ${clock})`;
    const remove = pg ? `"_unmapped_vault" - '${name}'` : `json_remove("_unmapped_vault", '$.${name}')`;
    const currentClock = pg ? `"_column_hlcs" ->> '${name}'` : `json_extract("_column_hlcs", '$.${name}')`;
    const wins = `NOT (${hasClock}) OR ${normalizedSqlHlc(clock, dialect)} >= ${normalizedSqlHlc(currentClock, dialect)}`;
    const rowClock = `CASE WHEN (${wins}) AND ${normalizedSqlHlc(clock, dialect)} > ${normalizedSqlHlc('"_crdt_hlc"', dialect)} THEN ${clock} ELSE "_crdt_hlc" END`;
    return {kind: 'sql', statement: `UPDATE ${table} SET ${column} = CASE WHEN ${wins} THEN ${value} ELSE ${column} END, "_column_hlcs" = CASE WHEN ${wins} THEN ${setClock} ELSE "_column_hlcs" END, "_unmapped_vault" = ${remove}, "_crdt_hlc" = ${rowClock} WHERE ${exists};`} as const;
  });
}

/**
 * Compile ordered SQL/application steps. Callers must run the complete plan in
 * one transaction and execute application transforms themselves. Snapshots made
 * before _column_hlcs existed cannot safely be migrated with this plan.
 */
export function compileMigrationOperationPlan(
  op: MigrationOperation,
  dialect: SqlDialect,
  sourceVersion: number,
  targetSchema: TableSchema,
  sourceSchema: TableSchema
): readonly SqlMigrationPlanStep[] {
  const table = quoteSqlIdentifier(op.table, 'table');
  const sql = (statement: string): SqlMigrationPlanStep => ({ kind: 'sql', statement });
  const pg = dialect === 'postgres';
  const path = (name: string): string => `'$.${assertValidSqlIdentifier(name, 'column')}'`;
  const key = (name: string): string => `'${assertValidSqlIdentifier(name, 'column')}'`;
  const has = (json: string, name: string): string => pg
    ? `${json} ? ${key(name)}` : `json_type(${json}, ${path(name)}) IS NOT NULL`;
  const text = (json: string, name: string): string => pg
    ? `${json} ->> ${key(name)}` : `json_extract(${json}, ${path(name)})`;
  const vaultEntry = (name: string): string => pg
    ? `"_unmapped_vault" -> ${key(name)}` : `json_extract("_unmapped_vault", ${path(name)})`;
  const field = (entry: string, name: string): string => pg
    ? `(${entry}) ->> '${name}'` : `json_extract(${entry}, '$.${name}')`;
  const setClock = (name: string, value: string): string => pg
    ? `jsonb_set("_column_hlcs", '{${name}}', to_jsonb(${value}), true)`
    : `json_set("_column_hlcs", ${path(name)}, ${value})`;
  const removeVault = (name: string): string => pg
    ? `"_unmapped_vault" - ${key(name)}` : `json_remove("_unmapped_vault", ${path(name)})`;

  switch (op.kind) {
    case 'add_column': {
      const col = op.column;
      const colIdent = quoteSqlIdentifier(col.name, 'column');
      const nullClause = col.nullable ? '' : ' NOT NULL';
      const literal = col.defaultValue !== undefined
        ? formatSqlLiteral(col.defaultValue, col.type, dialect)
        : col.nullable ? 'NULL' : formatSqlLiteral(defaultZeroForType(col.type), col.type, dialect);
      const vault = vaultEntry(col.name);
      const exists = has('"_unmapped_vault"', col.name);
      const restored = pg ? `(${field(vault, 'value')})::${mapSqlType(col.type, dialect)}` : field(vault, 'value');
      let fallback = colIdent;
      let fallbackHlc = `'000000000000000:0000:schema-default'`;
      if (op.backfillFromColumn) {
        const source = quoteSqlIdentifier(op.backfillFromColumn, 'source column');
        // An absent source is a valid migration input: the row upcaster uses the
        // added column's default. Do not reference a nonexistent SQL identifier;
        // SQLite can otherwise interpret it as a string literal.
        if (sourceSchema.columns.some((column) => column.name === op.backfillFromColumn)) {
          const sourceExists = has('"_column_hlcs"', op.backfillFromColumn);
          fallback = `CASE WHEN ${sourceExists} THEN ${source} ELSE ${colIdent} END`;
          fallbackHlc = `CASE WHEN ${sourceExists} THEN ${text('"_column_hlcs"', op.backfillFromColumn)} ELSE ${fallbackHlc} END`;
        }
      }
      const hlc = `CASE WHEN ${exists} THEN ${field(vault, 'hlc')} ELSE ${fallbackHlc} END`;
      return [
        sql(`ALTER TABLE ${table} ADD COLUMN ${colIdent} ${mapSqlType(col.type, dialect)}${nullClause} DEFAULT ${literal};`),
        sql(`UPDATE ${table} SET ${colIdent} = CASE WHEN ${exists} THEN ${restored} ELSE ${fallback} END, "_column_hlcs" = ${setClock(col.name, hlc)}, "_unmapped_vault" = ${removeVault(col.name)}, "_crdt_hlc" = CASE WHEN ${normalizedSqlHlc(hlc, dialect)} > ${normalizedSqlHlc('"_crdt_hlc"', dialect)} THEN ${hlc} ELSE "_crdt_hlc" END;`),
      ];
    }
    case 'rename_column': {
      const from = quoteSqlIdentifier(op.from, 'from column');
      const to = quoteSqlIdentifier(op.to, 'to column');
      const exists = has('"_column_hlcs"', op.from);
      const old = text('"_column_hlcs"', op.from);
      const renamed = pg
        ? `CASE WHEN ${exists} THEN jsonb_set("_column_hlcs" - ${key(op.from)}, '{${op.to}}', to_jsonb(${old}), true) ELSE "_column_hlcs" END`
        : `CASE WHEN ${exists} THEN json_set(json_remove("_column_hlcs", ${path(op.from)}), ${path(op.to)}, ${old}) ELSE "_column_hlcs" END`;
      return [sql(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to};`), sql(`UPDATE ${table} SET "_column_hlcs" = ${renamed};`)];
    }
    case 'drop_column_to_vault': {
      const column = quoteSqlIdentifier(op.column, 'dropped column');
      const columnHlc = text('"_column_hlcs"', op.column);
      const existingHlc = field(vaultEntry(op.column), 'hlc');
      const entryExists = has('"_unmapped_vault"', op.column);
      const cellExists = has('"_column_hlcs"', op.column);
      // Normalize the hex counter and compare node IDs bytewise.
      const condition = `${cellExists} AND (NOT (${entryExists}) OR ${normalizedSqlHlc(columnHlc, dialect)} >= ${normalizedSqlHlc(existingHlc, dialect)})`;
      const colType = sourceSchema.columns.find(c => c.name === op.column)?.type;
      const scalar = !pg && colType === 'BOOLEAN'
        ? `json(CASE WHEN ${column} IS NULL THEN 'null' WHEN ${column} THEN 'true' ELSE 'false' END)` : column;
      const entry = pg
        ? `jsonb_build_object('value', ${scalar}, 'hlc', ${columnHlc}, 'sourceVersion', ${sourceVersion})`
        : `json_object('value', ${scalar}, 'hlc', ${columnHlc}, 'sourceVersion', ${sourceVersion})`;
      const archive = pg
        ? `jsonb_set("_unmapped_vault", '{${op.column}}', ${entry}, true)`
        : `json_set("_unmapped_vault", ${path(op.column)}, json(${entry}))`;
      const removeClock = pg ? `"_column_hlcs" - ${key(op.column)}` : `json_remove("_column_hlcs", ${path(op.column)})`;
      return [
        sql(`UPDATE ${table} SET "_unmapped_vault" = CASE WHEN ${condition} THEN ${archive} ELSE "_unmapped_vault" END, "_column_hlcs" = ${removeClock};`),
        sql(`ALTER TABLE ${table} DROP COLUMN ${column};`),
      ];
    }
    case 'transform_column': {
      quoteSqlIdentifier(op.column, 'transformed column');
      assertValidSqlIdentifier(op.fnName, 'transform function name');
      return [{ kind: 'application_transform', operation: op, fromVersion: sourceVersion, toVersion: targetSchema.version, dialect, sourceSchema, targetSchema }];
    }
  }
}

export interface ParameterizedQuery {
  readonly sql: string;
  readonly params: readonly ScalarValue[];
}

export function compileParameterizedUpsert(
  schema: TableSchema,
  row: Readonly<Record<string, ScalarValue>>,
  hlc: string,
  unmappedVaultJson: string,
  dialect: SqlDialect,
  columnHlcsJson: string
): ParameterizedQuery {
  validateTableSchema(schema);
  const tableIdent = quoteSqlIdentifier(schema.tableName, 'table');
  const pkIdent = quoteSqlIdentifier(schema.primaryKey, 'primary key');

  const columnIdents: string[] = [];
  const placeholders: string[] = [];
  const params: ScalarValue[] = [];
  const updateAssignments: string[] = [];

  let paramIndex = 1;
  const nextPlaceholder = (): string => {
    const token = dialect === 'postgres' ? `$${paramIndex}` : '?';
    paramIndex += 1;
    return token;
  };

  for (const col of schema.columns) {
    const colIdent = quoteSqlIdentifier(col.name, 'column');
    const rawVal = Object.prototype.hasOwnProperty.call(row, col.name)
      ? (row[col.name] ?? null)
      : (col.defaultValue ?? null);
    const validatedVal = assertSafeScalarValue(rawVal, col.name, col.type, col.nullable);

    columnIdents.push(colIdent);
    placeholders.push(nextPlaceholder());
    params.push(dialect === 'sqlite' && typeof validatedVal === 'boolean' ? Number(validatedVal) : validatedVal);

    if (col.name !== schema.primaryKey) {
      updateAssignments.push(`${colIdent} = EXCLUDED.${colIdent}`);
    }
  }

  // Append metadata columns
  const metaColumns = ['"_crdt_hlc"', '"_column_hlcs"', '"_schema_version"', '"_unmapped_vault"'];
  const metaValues: ScalarValue[] = [hlc, columnHlcsJson, schema.version, unmappedVaultJson];

  for (let i = 0; i < metaColumns.length; i++) {
    const metaCol = metaColumns[i]!;
    const metaVal = metaValues[i]!;
    columnIdents.push(metaCol);
    placeholders.push(nextPlaceholder());
    params.push(metaVal);
    updateAssignments.push(`${metaCol} = EXCLUDED.${metaCol}`);
  }

  const sql = [
    `INSERT INTO ${tableIdent} (${columnIdents.join(', ')})`,
    `VALUES (${placeholders.join(', ')})`,
    `ON CONFLICT (${pkIdent}) DO UPDATE SET`,
    `  ${updateAssignments.join(',\n  ')}`,
    `WHERE ${normalizedSqlHlc('EXCLUDED."_crdt_hlc"', dialect)} >= ${normalizedSqlHlc(`${tableIdent}."_crdt_hlc"`, dialect)};`,
  ].join('\n');

  return { sql, params };
}

export function defaultZeroForType(type: ColumnDataType): ScalarValue {
  switch (type) {
    case 'TEXT':
      return '';
    case 'INTEGER':
    case 'REAL':
      return 0;
    case 'BOOLEAN':
      return false;
    case 'JSON':
      return '{}';
  }
}

export function evolveTableSchema(
  schema: TableSchema,
  targetVersion: number,
  operations: readonly MigrationOperation[]
): TableSchema {
  validateTableSchema(schema);
  let columns: ColumnSpec[] = [...schema.columns];

  for (const op of operations) {
    if (op.table !== schema.tableName) {
      continue;
    }
    switch (op.kind) {
      case 'add_column': {
        assertValidSqlIdentifier(op.column.name, 'added column');
        if (columns.some((c) => c.name === op.column.name)) {
          throw new SafetyViolationError(
            'COLUMN_ALREADY_EXISTS',
            `Cannot add column "${op.column.name}": already exists in "${schema.tableName}".`
          );
        }
        columns.push({ ...op.column });
        break;
      }

      case 'rename_column': {
        assertValidSqlIdentifier(op.from, 'source column');
        assertValidSqlIdentifier(op.to, 'target column');
        if (op.from === schema.primaryKey) {
          throw new SafetyViolationError(
            'CANNOT_RENAME_PRIMARY_KEY',
            `Cannot rename primary key column "${schema.primaryKey}".`
          );
        }
        const idx = columns.findIndex((c) => c.name === op.from);
        if (idx === -1) {
          throw new SafetyViolationError(
            'COLUMN_NOT_FOUND',
            `Cannot rename missing column "${op.from}" in "${schema.tableName}".`
          );
        }
        if (columns.some((c) => c.name === op.to)) {
          throw new SafetyViolationError(
            'COLUMN_ALREADY_EXISTS',
            `Cannot rename "${op.from}" to "${op.to}": target column already exists.`
          );
        }
        const existing = columns[idx]!;
        columns[idx] = {
          ...existing,
          name: op.to,
        };
        break;
      }

      case 'drop_column_to_vault': {
        assertValidSqlIdentifier(op.column, 'dropped column');
        if (op.column === schema.primaryKey) {
          throw new SafetyViolationError(
            'CANNOT_DROP_PRIMARY_KEY',
            `Cannot drop primary key column "${schema.primaryKey}".`
          );
        }
        if (!columns.some((c) => c.name === op.column)) {
          throw new SafetyViolationError(
            'COLUMN_NOT_FOUND',
            `Cannot drop missing column "${op.column}" in "${schema.tableName}".`
          );
        }
        columns = columns.filter((c) => c.name !== op.column);
        break;
      }

      case 'transform_column': {
        const idx = columns.findIndex((c) => c.name === op.column);
        if (idx === -1) {
          throw new SafetyViolationError(
            'COLUMN_NOT_FOUND',
            `Cannot transform missing column "${op.column}" in "${schema.tableName}".`
          );
        }
        if (op.targetType) {
          const existing = columns[idx]!;
          columns[idx] = {
            ...existing,
            type: op.targetType,
          };
        }
        break;
      }
    }
  }

  return validateTableSchema({
    tableName: schema.tableName,
    version: targetVersion,
    primaryKey: schema.primaryKey,
    columns,
  });
}

