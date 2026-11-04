import {
  assertSafeObjectKey,
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
  TableSchema,
} from './types';

/** Ordered persistence metadata columns shared by schema and SQL storage. */
export const CRDT_METADATA_COLUMNS = [
  '_crdt_hlc', '_column_hlcs', '_column_tie_values', '_tombstone_hlc',
  '_causal_version', '_schema_version', '_unmapped_vault',
] as const;

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
    assertSafeObjectKey(col.name);
    if ((CRDT_METADATA_COLUMNS as readonly string[]).includes(col.name.toLowerCase())) {
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
      if (col.type !== 'TEXT') {
        throw new SafetyViolationError('INVALID_PRIMARY_KEY_TYPE', `Primary key column "${col.name}" must have type TEXT.`);
      }
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
  const metadataTypes: Record<(typeof CRDT_METADATA_COLUMNS)[number], string> = {
    _crdt_hlc: 'TEXT NOT NULL', _column_hlcs: `${metaJsonType} NOT NULL`,
    _column_tie_values: `${metaJsonType} NOT NULL`, _tombstone_hlc: 'TEXT',
    _causal_version: 'INTEGER NOT NULL', _schema_version: `INTEGER NOT NULL DEFAULT ${schema.version}`,
    _unmapped_vault: `${metaJsonType} NOT NULL DEFAULT '{}'`,
  };
  for (const name of CRDT_METADATA_COLUMNS) colDefs.push(`  ${quoteSqlIdentifier(name)} ${metadataTypes[name]}`);

  return `CREATE TABLE IF NOT EXISTS ${tableIdent} (\n${colDefs.join(',\n')}\n);`;
}

export interface ParameterizedQuery {
  readonly sql: string;
  readonly params: readonly ScalarValue[];
}

export function compileParameterizedInsert(
  schema: TableSchema,
  row: Readonly<Record<string, ScalarValue>>,
  hlc: string,
  unmappedVaultJson: string,
  dialect: SqlDialect,
  columnHlcsJson: string,
  tombstoneHlc: string | null = null,
  columnTieValuesJson = '{}'
): ParameterizedQuery {
  validateTableSchema(schema);
  const tableIdent = quoteSqlIdentifier(schema.tableName, 'table');
  const pkIdent = quoteSqlIdentifier(schema.primaryKey, 'primary key');

  const columnIdents: string[] = [];
  const placeholders: string[] = [];
  const params: ScalarValue[] = [];

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

  }

  // Append metadata columns
  const metaValues: Record<(typeof CRDT_METADATA_COLUMNS)[number], ScalarValue> = {
    _crdt_hlc: hlc, _column_hlcs: columnHlcsJson, _column_tie_values: columnTieValuesJson,
    _tombstone_hlc: tombstoneHlc, _causal_version: 2, _schema_version: schema.version,
    _unmapped_vault: unmappedVaultJson,
  };

  for (const metaCol of CRDT_METADATA_COLUMNS) {
    columnIdents.push(quoteSqlIdentifier(metaCol));
    placeholders.push(nextPlaceholder());
    params.push(metaValues[metaCol]);
  }

  const sql = [
    `INSERT INTO ${tableIdent} (${columnIdents.join(', ')})`,
    `VALUES (${placeholders.join(', ')})`,
    `ON CONFLICT (${pkIdent}) DO NOTHING;`,
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
        assertSafeObjectKey(op.column.name);
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
        assertSafeObjectKey(op.from);
        assertSafeObjectKey(op.to);
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
        assertSafeObjectKey(op.column);
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
        assertValidSqlIdentifier(op.column, 'transformed column');
        assertSafeObjectKey(op.column);
        if (op.column === schema.primaryKey) {
          throw new SafetyViolationError('CANNOT_TRANSFORM_PRIMARY_KEY', `Cannot transform primary key column "${schema.primaryKey}".`);
        }
        const idx = columns.findIndex((c) => c.name === op.column);
        if (idx === -1) {
          throw new SafetyViolationError(
            'COLUMN_NOT_FOUND',
            `Cannot transform missing column "${op.column}" in "${schema.tableName}".`
          );
        }
        const existing = columns[idx]!;
        const type = op.targetType ?? existing.type;
        columns[idx] = {
          ...existing,
          type,
          ...(existing.defaultValue === undefined ? {} : {
            defaultValue: assertSafeScalarValue(op.transform(existing.defaultValue), op.column, type, existing.nullable),
          }),
        };
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

