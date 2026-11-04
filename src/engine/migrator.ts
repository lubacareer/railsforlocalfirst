import { compareHlc, formatHlc } from './hlc';
import {
  assertSafeScalarValue,
  assertValidSqlIdentifier,
  createSafeRecord,
  SafetyViolationError,
} from './safety';
import {
  compileMigrationOperationSql,
  defaultZeroForType,
  evolveTableSchema,
  validateTableSchema,
} from './schema';
import type {
  CrdtCell,
  CrdtChangeOperation,
  CrdtRowState,
  MigrationReport,
  MigrationStep,
  ScalarValue,
  SqlDialect,
  TableSchema,
  UnmappedVaultEntry,
} from './types';

/**
 * Epoch-zero HLC used for schema-migration default values so that any real user
 * mutation from any peer (regardless of when the migration ran locally) always
 * wins LWW conflict resolution over a synthetic schema default.
 */
export const MIGRATION_DEFAULT_HLC = formatHlc({
  wallTimeMs: 0,
  counter: 0,
  nodeId: 'schema-default',
});

export class SchemaMigrationRegistry {
  private readonly initialSchema: TableSchema;
  private readonly stepsByFromVersion = new Map<number, MigrationStep>();
  private readonly schemasByVersion = new Map<number, TableSchema>();
  private maxVersion: number;

  constructor(initialSchema: TableSchema, steps: readonly MigrationStep[] = []) {
    this.initialSchema = validateTableSchema(initialSchema);
    this.schemasByVersion.set(initialSchema.version, this.initialSchema);
    this.maxVersion = initialSchema.version;

    for (const step of steps) {
      this.registerStep(step);
    }
  }

  public registerStep(step: MigrationStep): void {
    if (
      !Number.isSafeInteger(step.fromVersion) ||
      !Number.isSafeInteger(step.toVersion) ||
      step.toVersion !== step.fromVersion + 1
    ) {
      throw new SafetyViolationError(
        'NON_CONTIGUOUS_MIGRATION',
        `Migration step must increment version by exactly 1 (got v${String(step.fromVersion)} -> v${String(step.toVersion)}).`
      );
    }
    if (step.fromVersion !== this.maxVersion) {
      throw new SafetyViolationError(
        'MIGRATION_CHAIN_GAP',
        `Expected migration from v${this.maxVersion}, but received step from v${step.fromVersion}.`
      );
    }
    if (this.stepsByFromVersion.has(step.fromVersion)) {
      throw new SafetyViolationError(
        'DUPLICATE_MIGRATION_STEP',
        `Migration step from v${step.fromVersion} is already registered.`
      );
    }

    const currentSchema = this.schemasByVersion.get(step.fromVersion)!;
    const nextSchema = evolveTableSchema(currentSchema, step.toVersion, step.operations);

    this.stepsByFromVersion.set(step.fromVersion, step);
    this.schemasByVersion.set(step.toVersion, nextSchema);
    this.maxVersion = step.toVersion;
  }

  public getTableName(): string {
    return this.initialSchema.tableName;
  }

  public getLatestVersion(): number {
    return this.maxVersion;
  }

  public getSchemaAtVersion(version: number): TableSchema {
    const schema = this.schemasByVersion.get(version);
    if (!schema) {
      throw new SafetyViolationError(
        'UNKNOWN_SCHEMA_VERSION',
        `Schema version v${String(version)} is not registered for table "${this.initialSchema.tableName}".`
      );
    }
    return schema;
  }

  public getStepsBetween(fromVersion: number, toVersion: number): readonly MigrationStep[] {
    if (fromVersion === toVersion) {
      this.getSchemaAtVersion(fromVersion);
      return [];
    }
    if (fromVersion > toVersion) {
      throw new SafetyViolationError(
        'DOWNGRADE_NOT_SUPPORTED',
        `Cannot run forward migration steps from v${fromVersion} down to v${toVersion}.`
      );
    }
    this.getSchemaAtVersion(fromVersion);
    this.getSchemaAtVersion(toVersion);

    const steps: MigrationStep[] = [];
    for (let v = fromVersion; v < toVersion; v++) {
      const step = this.stepsByFromVersion.get(v);
      if (!step) {
        throw new SafetyViolationError(
          'MISSING_MIGRATION_STEP',
          `Missing migration step for v${v} -> v${v + 1}.`
        );
      }
      steps.push(step);
    }
    return steps;
  }

  public compileSqlForRange(
    fromVersion: number,
    toVersion: number,
    dialect: SqlDialect
  ): readonly string[] {
    const steps = this.getStepsBetween(fromVersion, toVersion);
    const statements: string[] = [];

    for (const step of steps) {
      statements.push(`-- Migration v${step.fromVersion} -> v${step.toVersion}: ${step.description}`);
      for (const op of step.operations) {
        statements.push(...compileMigrationOperationSql(op, dialect));
      }
    }
    return statements;
  }

  /**
   * Deterministically upgrades a local CRDT row state from its current schemaVersion
   * to targetVersion with zero data loss.
   */
  public upcastRowState(
    row: CrdtRowState,
    targetVersion: number
  ): {
    readonly row: CrdtRowState;
    readonly preservedVaultDelta: number;
    readonly restoredVaultDelta: number;
  } {
    if (row.table !== this.initialSchema.tableName) {
      throw new SafetyViolationError(
        'TABLE_MISMATCH',
        `Row table "${row.table}" does not match registry table "${this.initialSchema.tableName}".`
      );
    }

    if (row.schemaVersion === targetVersion) {
      return {
        row: cloneRowState(row),
        preservedVaultDelta: 0,
        restoredVaultDelta: 0,
      };
    }

    const steps = this.getStepsBetween(row.schemaVersion, targetVersion);
    let cells = createSafeRecord<CrdtCell>(Object.entries(row.cells));
    let unmappedFields = createSafeRecord<UnmappedVaultEntry>(
      Object.entries(row.unmappedFields)
    );
    let preservedVaultDelta = 0;
    let restoredVaultDelta = 0;

    for (const step of steps) {
      const targetStepSchema = this.getSchemaAtVersion(step.toVersion);

      for (const op of step.operations) {
        if (op.table !== row.table) {
          continue;
        }

        switch (op.kind) {
          case 'add_column': {
            const colName = assertValidSqlIdentifier(op.column.name, 'column');
            const vaultEntry = unmappedFields[colName];

            if (vaultEntry !== undefined) {
              const validated = assertSafeScalarValue(
                vaultEntry.value,
                colName,
                op.column.type,
                op.column.nullable
              );
              cells[colName] = {
                value: validated,
                hlc: vaultEntry.hlc,
              };
              delete unmappedFields[colName];
              restoredVaultDelta += 1;
            } else if (
              op.backfillFromColumn &&
              cells[op.backfillFromColumn] !== undefined
            ) {
              const sourceCell = cells[op.backfillFromColumn]!;
              const validated = assertSafeScalarValue(
                sourceCell.value,
                colName,
                op.column.type,
                op.column.nullable
              );
              cells[colName] = {
                value: validated,
                hlc: sourceCell.hlc,
              };
            } else {
              const fallbackValue =
                op.column.defaultValue !== undefined
                  ? op.column.defaultValue
                  : op.column.nullable
                    ? null
                    : defaultZeroForType(op.column.type);
              const validated = assertSafeScalarValue(
                fallbackValue,
                colName,
                op.column.type,
                op.column.nullable
              );
              cells[colName] = {
                value: validated,
                hlc: MIGRATION_DEFAULT_HLC,
              };
            }
            break;
          }

          case 'rename_column': {
            const fromCol = assertValidSqlIdentifier(op.from, 'from column');
            const toCol = assertValidSqlIdentifier(op.to, 'to column');
            const existingCell = cells[fromCol];
            if (existingCell !== undefined) {
              cells[toCol] = { ...existingCell };
              delete cells[fromCol];
            }
            break;
          }

          case 'drop_column_to_vault': {
            const droppedCol = assertValidSqlIdentifier(op.column, 'dropped column');
            const existingCell = cells[droppedCol];
            if (existingCell !== undefined) {
              const existingVault = unmappedFields[droppedCol];
              if (!existingVault || compareHlc(existingCell.hlc, existingVault.hlc) >= 0) {
                unmappedFields[droppedCol] = {
                  value: existingCell.value,
                  hlc: existingCell.hlc,
                  sourceVersion: step.fromVersion,
                };
              }
              delete cells[droppedCol];
              preservedVaultDelta += 1;
            }
            break;
          }

          case 'transform_column': {
            const colName = assertValidSqlIdentifier(op.column, 'transformed column');
            const existingCell = cells[colName];
            if (existingCell !== undefined) {
              const plainRow = createSafeRecord<ScalarValue>();
              for (const [k, cell] of Object.entries(cells)) {
                plainRow[k] = cell.value;
              }
              const transformedValue = op.transform(
                existingCell.value,
                Object.freeze({ ...plainRow })
              );
              const colSpec = targetStepSchema.columns.find((c) => c.name === colName);
              const validated = assertSafeScalarValue(
                transformedValue,
                colName,
                colSpec?.type,
                colSpec?.nullable ?? true
              );
              cells[colName] = {
                value: validated,
                hlc: existingCell.hlc,
              };
            }
            break;
          }
        }
      }

      // If any unmapped vault fields now match a valid column in targetStepSchema, restore them
      for (const colSpec of targetStepSchema.columns) {
        const vaultEntry = unmappedFields[colSpec.name];
        if (vaultEntry !== undefined) {
          const currentCell = cells[colSpec.name];
          if (!currentCell || compareHlc(vaultEntry.hlc, currentCell.hlc) >= 0) {
            const validated = assertSafeScalarValue(
              vaultEntry.value,
              colSpec.name,
              colSpec.type,
              colSpec.nullable
            );
            cells[colSpec.name] = {
              value: validated,
              hlc: vaultEntry.hlc,
            };
          }
          delete unmappedFields[colSpec.name];
          restoredVaultDelta += 1;
        }
      }
    }

    return {
      row: {
        pk: row.pk,
        table: row.table,
        schemaVersion: targetVersion,
        tombstoneHlc: row.tombstoneHlc,
        cells,
        unmappedFields,
      },
      preservedVaultDelta,
      restoredVaultDelta,
    };
  }

  /**
   * Normalizes an incoming or outgoing CRDT change operation from any schema version
   * (older OR newer than local targetVersion) into targetVersion without losing fields.
   */
  public normalizeChangeOperation(
    op: CrdtChangeOperation,
    targetVersion: number
  ): {
    readonly operation: CrdtChangeOperation;
    readonly wasUpcasted: boolean;
    readonly preservedFutureFieldCount: number;
  } {
    if (op.table !== this.initialSchema.tableName) {
      throw new SafetyViolationError(
        'TABLE_MISMATCH',
        `Operation table "${op.table}" does not match registry table "${this.initialSchema.tableName}".`
      );
    }

    if (op.kind === 'delete') {
      return {
        operation: {
          ...op,
          schemaVersion: targetVersion,
          columns: createSafeRecord<CrdtCell>(),
        },
        wasUpcasted: op.schemaVersion !== targetVersion,
        preservedFutureFieldCount: 0,
      };
    }

    // Case 1: Operation is from an older schema version -> run forward lens upcasting
    if (op.schemaVersion < targetVersion) {
      const syntheticRow: CrdtRowState = {
        pk: op.pk,
        table: op.table,
        schemaVersion: op.schemaVersion,
        tombstoneHlc: null,
        cells: createSafeRecord<CrdtCell>(Object.entries(op.columns)),
        unmappedFields: createSafeRecord<UnmappedVaultEntry>(
          op.unmappedFields ? Object.entries(op.unmappedFields) : []
        ),
      };

      const { row: upcasted } = this.upcastRowState(syntheticRow, targetVersion);

      // Filter out synthetic default cells that were not actually part of a sparse partial update
      // unless they were derived via rename/backfill/transform from a column present in op.columns.
      const filteredCells = createSafeRecord<CrdtCell>();
      for (const [colName, cell] of Object.entries(upcasted.cells)) {
        if (cell.hlc !== MIGRATION_DEFAULT_HLC || op.columns[colName] !== undefined) {
          filteredCells[colName] = cell;
        }
      }

      return {
        operation: {
          ...op,
          schemaVersion: targetVersion,
          columns: filteredCells,
          unmappedFields: upcasted.unmappedFields,
        },
        wasUpcasted: true,
        preservedFutureFieldCount: Object.keys(upcasted.unmappedFields).length,
      };
    }

    // Case 2: Operation is from a NEWER schema version (peer is ahead of local client)
    // Preserve any unrecognized columns in unmappedFields so zero data is lost!
    const targetSchema = this.getSchemaAtVersion(targetVersion);
    const knownColumns = new Set(targetSchema.columns.map((c) => c.name));
    const recognizedCells = createSafeRecord<CrdtCell>();
    const unmappedFields = createSafeRecord<UnmappedVaultEntry>(
      op.unmappedFields ? Object.entries(op.unmappedFields) : []
    );
    let preservedFutureFieldCount = 0;

    for (const [colName, cell] of Object.entries(op.columns)) {
      assertValidSqlIdentifier(colName, 'operation column');
      if (knownColumns.has(colName)) {
        const colSpec = targetSchema.columns.find((c) => c.name === colName)!;
        const validated = assertSafeScalarValue(
          cell.value,
          colName,
          colSpec.type,
          colSpec.nullable
        );
        recognizedCells[colName] = {
          value: validated,
          hlc: cell.hlc,
        };
      } else {
        unmappedFields[colName] = {
          value: assertSafeScalarValue(cell.value, colName),
          hlc: cell.hlc,
          sourceVersion: op.schemaVersion,
        };
        preservedFutureFieldCount += 1;
      }
    }

    return {
      operation: {
        ...op,
        schemaVersion: targetVersion,
        columns: recognizedCells,
        unmappedFields,
      },
      wasUpcasted: false,
      preservedFutureFieldCount,
    };
  }
}

export function cloneRowState(row: CrdtRowState): CrdtRowState {
  const cells = createSafeRecord<CrdtCell>();
  for (const [k, v] of Object.entries(row.cells)) {
    cells[k] = { value: v.value, hlc: v.hlc };
  }
  const unmappedFields = createSafeRecord<UnmappedVaultEntry>();
  for (const [k, v] of Object.entries(row.unmappedFields)) {
    unmappedFields[k] = {
      value: v.value,
      hlc: v.hlc,
      sourceVersion: v.sourceVersion,
    };
  }
  return {
    pk: row.pk,
    table: row.table,
    schemaVersion: row.schemaVersion,
    tombstoneHlc: row.tombstoneHlc,
    cells,
    unmappedFields,
  };
}

export function buildMigrationReport(params: {
  table: string;
  fromVersion: number;
  toVersion: number;
  migratedRowCount: number;
  upcastedOutboxCount: number;
  preservedVaultFieldCount: number;
  restoredFromVaultFieldCount: number;
  generatedSql: readonly string[];
}): MigrationReport {
  return Object.freeze({ ...params });
}

