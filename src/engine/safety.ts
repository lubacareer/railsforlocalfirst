import type { ColumnDataType, ScalarValue } from './types';

const SQL_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const NODE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const STORAGE_KEY_REGEX = /^[a-zA-Z0-9_.-]{1,128}$/;
const RECORD_PK_REGEX = /^[a-zA-Z0-9_:.-]{1,128}$/;

const RESERVED_SQL_KEYWORDS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TABLE',
  'WHERE',
  'FROM',
  'JOIN',
  'UNION',
  'GRANT',
  'REVOKE',
  'TRUNCATE',
  'EXEC',
  'EXECUTE',
  'PRAGMA',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
]);

const FORBIDDEN_OBJECT_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB hard ceiling per sync batch
export const MAX_BATCH_OPERATIONS = 5000;
export const MAX_STRING_CELL_LENGTH = 262_144; // 256 KiB per scalar string

export class SafetyViolationError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'SafetyViolationError';
    this.code = code;
    Object.setPrototypeOf(this, SafetyViolationError.prototype);
  }
}

/** A caller-provided migration transform failed; callers may retry after fixing it. */
export class MigrationTransformError extends SafetyViolationError {
  public override readonly cause: unknown;

  constructor(fnName: string, column: string, cause: unknown) {
    super('MIGRATION_TRANSFORM_FAILED', `Migration transform "${fnName}" for "${column}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationTransformError';
    this.cause = cause;
    Object.setPrototypeOf(this, MigrationTransformError.prototype);
  }
}

/** Mark only errors thrown by user-provided code as transform failures. */
export function runMigrationTransform(transform: (value: ScalarValue) => ScalarValue, value: ScalarValue, fnName: string, column: string): ScalarValue {
  try {
    return transform(value);
  } catch (error) {
    throw new MigrationTransformError(fnName, column, error);
  }
}

export function assertValidSqlIdentifier(identifier: string, context = 'identifier'): string {
  if (typeof identifier !== 'string' || !SQL_IDENTIFIER_REGEX.test(identifier)) {
    throw new SafetyViolationError(
      'INVALID_SQL_IDENTIFIER',
      `Invalid SQL ${context}: "${String(identifier)}". Must match ${SQL_IDENTIFIER_REGEX.source}.`
    );
  }
  if (RESERVED_SQL_KEYWORDS.has(identifier.toUpperCase())) {
    throw new SafetyViolationError(
      'RESERVED_SQL_IDENTIFIER',
      `SQL ${context} "${identifier}" is a reserved keyword and cannot be used.`
    );
  }
  return identifier;
}

export function quoteSqlIdentifier(identifier: string, context = 'identifier'): string {
  const safe = assertValidSqlIdentifier(identifier, context);
  return `"${safe}"`;
}

export function assertValidNodeId(nodeId: string): string {
  if (typeof nodeId !== 'string' || !NODE_ID_REGEX.test(nodeId)) {
    throw new SafetyViolationError(
      'INVALID_NODE_ID',
      `Invalid nodeId "${String(nodeId)}". Must be 1-64 alphanumeric, underscore, or hyphen characters.`
    );
  }
  return nodeId;
}

export function assertValidStorageKey(key: string): string {
  if (
    typeof key !== 'string' ||
    !STORAGE_KEY_REGEX.test(key) ||
    key.includes('..') ||
    key.startsWith('.') ||
    key.endsWith('.')
  ) {
    throw new SafetyViolationError(
      'UNSAFE_STORAGE_KEY',
      `Unsafe storage key "${String(key)}". Path traversal or special characters are forbidden.`
    );
  }
  return key;
}

export function assertValidPrimaryKey(pk: string): string {
  if (typeof pk !== 'string' || !RECORD_PK_REGEX.test(pk) || pk.includes('..')) {
    throw new SafetyViolationError(
      'INVALID_PRIMARY_KEY',
      `Invalid primary key "${String(pk)}". Must match ${RECORD_PK_REGEX.source} without "..".`
    );
  }
  return pk;
}

export function assertSafeObjectKey(key: string): string {
  if (typeof key !== 'string' || FORBIDDEN_OBJECT_KEYS.has(key)) {
    throw new SafetyViolationError(
      'PROTOTYPE_POLLUTION_DETECTED',
      `Forbidden object property key "${String(key)}" detected.`
    );
  }
  return key;
}

export function assertSafeScalarValue(
  value: unknown,
  columnName: string,
  expectedType?: ColumnDataType,
  nullable = true
): ScalarValue {
  if (value === null) {
    if (!nullable) {
      throw new SafetyViolationError(
        'NULL_CONSTRAINT_VIOLATION',
        `Column "${columnName}" cannot be null.`
      );
    }
    return null;
  }

  if (typeof value === 'string') {
    if (value.length > MAX_STRING_CELL_LENGTH) {
      throw new SafetyViolationError(
        'VALUE_TOO_LARGE',
        `Column "${columnName}" exceeds maximum length of ${MAX_STRING_CELL_LENGTH} characters.`
      );
    }
    if (expectedType && expectedType !== 'TEXT' && expectedType !== 'JSON') {
      throw new SafetyViolationError(
        'TYPE_MISMATCH',
        `Column "${columnName}" expects ${expectedType}, got string.`
      );
    }
    if (expectedType === 'JSON') {
      safeJsonParse(value);
    }
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SafetyViolationError(
        'NON_FINITE_NUMBER',
        `Column "${columnName}" must be a finite number (NaN/Infinity forbidden).`
      );
    }
    if (expectedType === 'INTEGER' && !Number.isSafeInteger(value)) {
      throw new SafetyViolationError(
        'INTEGER_CONSTRAINT_VIOLATION',
        `Column "${columnName}" expects a safe integer, got ${value}.`
      );
    }
    if (expectedType && expectedType !== 'INTEGER' && expectedType !== 'REAL') {
      throw new SafetyViolationError(
        'TYPE_MISMATCH',
        `Column "${columnName}" expects ${expectedType}, got number.`
      );
    }
    return value;
  }

  if (typeof value === 'boolean') {
    if (expectedType && expectedType !== 'BOOLEAN') {
      throw new SafetyViolationError(
        'TYPE_MISMATCH',
        `Column "${columnName}" expects ${expectedType}, got boolean.`
      );
    }
    return value;
  }

  throw new SafetyViolationError(
    'UNSUPPORTED_SCALAR_TYPE',
    `Column "${columnName}" received unsupported value of type ${typeof value}.`
  );
}

export function assertNoPrototypePollution(value: unknown, depth = 0): void {
  if (depth > 16) {
    throw new SafetyViolationError(
      'MAX_OBJECT_DEPTH_EXCEEDED',
      'Object nesting depth exceeds safety limit (16).'
    );
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoPrototypePollution(item, depth + 1);
    }
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new SafetyViolationError(
      'INVALID_OBJECT_PROTOTYPE',
      'Only plain objects are permitted in serialized payloads.'
    );
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    assertSafeObjectKey(key);
    assertNoPrototypePollution((value as Record<string, unknown>)[key], depth + 1);
  }
}

export function safeJsonParse<T = unknown>(raw: string): T {
  if (typeof raw !== 'string') {
    throw new SafetyViolationError('INVALID_JSON_INPUT', 'JSON input must be a string.');
  }
  const byteLength = new TextEncoder().encode(raw).byteLength;
  if (byteLength > MAX_PAYLOAD_BYTES) {
    throw new SafetyViolationError(
      'PAYLOAD_TOO_LARGE',
      `JSON payload (${byteLength} bytes) exceeds maximum allowed (${MAX_PAYLOAD_BYTES} bytes).`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, (key, val) => {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        throw new SafetyViolationError(
          'PROTOTYPE_POLLUTION_DETECTED',
          `Forbidden key "${key}" encountered during JSON parsing.`
        );
      }
      return val;
    });
  } catch (err) {
    if (err instanceof SafetyViolationError) {
      throw err;
    }
    throw new SafetyViolationError(
      'MALFORMED_JSON',
      `Failed to parse JSON safely: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  assertNoPrototypePollution(parsed);
  return parsed as T;
}

export function createSafeRecord<T>(entries?: Iterable<readonly [string, T]>): Record<string, T> {
  const map = Object.create(null) as Record<string, T>;
  if (entries) {
    for (const [k, v] of entries) {
      assertSafeObjectKey(k);
      map[k] = v;
    }
  }
  return map;
}
