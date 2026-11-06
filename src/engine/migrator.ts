import { formatHlc } from './hlc';
import {
  assertSafeObjectKey,
  assertSafeScalarValue,
  assertValidSqlIdentifier,
  createSafeRecord,
  runMigrationTransform,
  SafetyViolationError,
} from './safety';
import {
  defaultZeroForType,
  evolveTableSchema,
  validateTableSchema,
} from './schema';
import { canonicalHlc, cellWins, flattenVaultEntry, mergeVaultEntries, packVaultEntries, validateVaultEntry } from './vault';
import type {
  CrdtCell,
  CrdtChangeOperation,
  CrdtRowState,
  MigrationReport,
  MigrationStep,
  SqlDialect,
  SqlMigrationPlanStep,
  TableSchema,
  UnmappedVaultEntry,
} from './types';

type LineageState = Record<string, { readonly id: string; readonly revision: number }>;

function copyLineage(state: LineageState): LineageState {
  return createSafeRecord(Object.entries(state).map(([name, lineage]) => [name, { ...lineage }]));
}

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
  private readonly lineageCache = new Map<string, LineageState>();
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

    this.lineageCache.clear();
    this.stepsByFromVersion.set(step.fromVersion, step);
    this.schemasByVersion.set(step.toVersion, nextSchema);
    this.maxVersion = step.toVersion;
    try {
      for (const op of step.operations) {
        if (op.kind === 'add_column' && op.restoreFrom) {
          assertValidSqlIdentifier(op.restoreFrom.column, 'restored column');
          if (!Number.isSafeInteger(op.restoreFrom.version) || op.restoreFrom.version < this.initialSchema.version || op.restoreFrom.version > step.fromVersion) {
            throw new SafetyViolationError('UNKNOWN_RESTORED_LINEAGE', 'restoreFrom must identify a field in an earlier registered schema.');
          }
        }
      }
      this.lineageState(step.toVersion);
      this.lineageCache.clear();
    } catch (error) {
      this.stepsByFromVersion.delete(step.fromVersion);
      this.schemasByVersion.delete(step.toVersion);
      this.maxVersion = step.fromVersion;
      this.lineageCache.clear();
      throw error;
    }
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

  /** Ordered SQL and application steps; all steps must run in one transaction. */
  public compileMigrationPlan(
    fromVersion: number,
    toVersion: number,
    dialect: SqlDialect
  ): readonly SqlMigrationPlanStep[] {
    const steps = this.getStepsBetween(fromVersion, toVersion);
    return steps.map((step) => ({
      kind: 'application_migration' as const,
      step,
      sourceSchema: this.getSchemaAtVersion(step.fromVersion),
      targetSchema: this.getSchemaAtVersion(step.toVersion),
      dialect,
    }));
  }

  /** Reconstruct stable field identities and representation revisions at a schema position. */
  private lineageState(version: number, position: number | 'end' = 'end'): LineageState {
    this.getSchemaAtVersion(version);
    const cacheKey = JSON.stringify([version, position]);
    const cached = this.lineageCache.get(cacheKey);
    if (cached) return copyLineage(cached);
    const initial: LineageState = createSafeRecord();
    for (const col of this.initialSchema.columns) {
      initial[assertSafeObjectKey(col.name)] = { id: `v${this.initialSchema.version}:base:${col.name}`, revision: 0 };
    }
    const history = new Map<number, LineageState>([[this.initialSchema.version, createSafeRecord(Object.entries(initial))]]);
    const current: LineageState = createSafeRecord(Object.entries(initial));
    const revisions = new Map(Object.values(initial).map((lineage) => [lineage.id, lineage.revision]));
    if (version === this.initialSchema.version) {
      if (position !== 'end') throw new SafetyViolationError('INVALID_SCHEMA_POSITION', 'Initial schema has no migration operations.');
      this.lineageCache.set(cacheKey, copyLineage(current));
      return current;
    }
    for (const step of this.getStepsBetween(this.initialSchema.version, version)) {
      const limit = step.toVersion === version && position !== 'end' ? position : step.operations.length;
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > step.operations.length) {
        throw new SafetyViolationError('INVALID_SCHEMA_POSITION', 'Schema position is outside its migration step.');
      }
      for (let i = 0; i < limit; i++) {
        const op = step.operations[i]!;
        if (op.table !== this.getTableName()) continue;
        switch (op.kind) {
          case 'add_column': {
            assertSafeObjectKey(op.column.name);
            if (op.restoreFrom) {
              assertSafeObjectKey(op.restoreFrom.column);
              const restored = history.get(op.restoreFrom.version)?.[op.restoreFrom.column];
              if (!restored) throw new SafetyViolationError('UNKNOWN_RESTORED_LINEAGE', 'restoreFrom must identify a field in an earlier registered schema.');
              if (Object.values(current).some((active) => active.id === restored.id)) {
                throw new SafetyViolationError('ACTIVE_RESTORED_LINEAGE', 'Cannot restore a lineage that is already active.');
              }
              current[op.column.name] = { ...restored, revision: revisions.get(restored.id) ?? restored.revision };
            } else {
              current[op.column.name] = { id: `v${step.toVersion}:op${i}:${op.column.name}`, revision: 0 };
              revisions.set(current[op.column.name]!.id, 0);
            }
            break;
          }
          case 'rename_column': {
            assertSafeObjectKey(op.from);
            assertSafeObjectKey(op.to);
            const prior = current[op.from];
            if (prior) current[op.to] = prior;
            delete current[op.from];
            break;
          }
          case 'drop_column_to_vault': delete current[assertSafeObjectKey(op.column)]; break;
          case 'transform_column': {
            assertSafeObjectKey(op.column);
            const prior = current[op.column];
            if (prior) {
              current[op.column] = { ...prior, revision: prior.revision + 1 };
              revisions.set(prior.id, prior.revision + 1);
            }
            break;
          }
        }
      }
      history.set(step.toVersion, createSafeRecord(Object.entries(current)));
    }
    this.lineageCache.set(cacheKey, copyLineage(current));
    return current;
  }

  private upcastVaultValue(field: string, entry: UnmappedVaultEntry, targetVersion: number): { column: string; cell: CrdtCell } | null {
    if (entry.schemaPosition === undefined || entry.sourceVersion > targetVersion || entry.sourceVersion > this.maxVersion) return null;
    let source: LineageState;
    try { source = this.lineageState(entry.sourceVersion, entry.schemaPosition); } catch (error) {
      if (error instanceof SafetyViolationError && (error.code === 'INVALID_SCHEMA_POSITION' || error.code === 'UNKNOWN_SCHEMA_VERSION')) return null;
      throw error;
    }
    const sourceLineage = source[field];
    if (!sourceLineage || (entry.lineageId !== undefined && entry.lineageId !== sourceLineage.id)) return null;
    const target = this.lineageState(targetVersion);
    const destination = Object.entries(target).find(([, state]) => state.id === sourceLineage.id);
    if (!destination) return null;
    let value = entry.value;
    let tieValue = entry.tieValue;
    let hasTieValue = Object.prototype.hasOwnProperty.call(entry, 'tieValue');
    for (let v = entry.sourceVersion; v <= targetVersion; v++) {
      const step = this.stepsByFromVersion.get(v - 1);
      if (!step) continue;
      const start = v === entry.sourceVersion ? (entry.schemaPosition === 'end' ? step.operations.length : entry.schemaPosition) : 0;
      for (let i = start; i < step.operations.length; i++) {
        const operation = step.operations[i]!;
        if (operation.table !== this.getTableName() || operation.kind !== 'transform_column') continue;
        const before = this.lineageState(v, i);
        if (before[operation.column]?.id === sourceLineage.id) {
          if (!hasTieValue) { tieValue = value; hasTieValue = true; }
          value = runMigrationTransform(operation.transform, value, operation.fnName, operation.column);
        }
      }
    }
    const col = this.getSchemaAtVersion(targetVersion).columns.find((c) => c.name === destination[0])!;
    return { column: col.name, cell: { value: assertSafeScalarValue(value, col.name, col.type, col.nullable), hlc: entry.hlc,
      ...(hasTieValue && { tieValue: tieValue! }) } };
  }

  private reconcileVault(cells: Record<string, CrdtCell>, vault: Record<string, UnmappedVaultEntry>, version: number): number {
    let count = 0;
    for (const [field, packed] of Object.entries(vault)) {
      const remaining: UnmappedVaultEntry[] = [];
      for (const entry of flattenVaultEntry(packed)) {
        const restored = this.upcastVaultValue(field, entry, version);
        if (!restored) { remaining.push(entry); continue; }
        const current = cells[restored.column];
        if (!current || cellWins(restored.cell, current)) cells[restored.column] = restored.cell;
        count++;
      }
      const rest = packVaultEntries(remaining);
      if (rest) vault[field] = rest;
      else delete vault[field];
    }
    return count;
  }

  /** Explicitly assign provenance to one ambiguous legacy entry; no value is guessed. */
  public mapLegacyVaultEntry(row: CrdtRowState, field: string, legacyIndex: number, sourceVersion: number, schemaPosition: number | 'end'): CrdtRowState {
    assertValidSqlIdentifier(field, 'unmapped field');
    assertSafeObjectKey(field);
    const result = cloneRowState(row);
    const packed = result.unmappedFields[field];
    if (!packed || !Number.isSafeInteger(legacyIndex) || legacyIndex < 0) {
      throw new SafetyViolationError('INVALID_VAULT_ENTRY', 'Legacy vault entry not found.');
    }
    const entries = flattenVaultEntry(packed);
    const selected = entries[legacyIndex];
    if (!selected || selected.schemaPosition !== undefined) {
      throw new SafetyViolationError('INVALID_VAULT_ENTRY', 'Selected vault entry is not ambiguous legacy data.');
    }
    const lineage = this.lineageState(sourceVersion, schemaPosition)[field];
    if (!lineage) throw new SafetyViolationError('UNKNOWN_RESTORED_LINEAGE', 'No field exists at the specified schema position.');
    entries[legacyIndex] = { ...selected, sourceVersion, schemaPosition, lineageId: lineage.id };
    result.unmappedFields[field] = packVaultEntries(entries)!;
    this.reconcileVault(result.cells, result.unmappedFields, row.schemaVersion);
    return result;
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
      const copy = cloneRowState(row);
      const restoredVaultDelta = this.reconcileVault(copy.cells, copy.unmappedFields, targetVersion);
      return {
        row: copy,
        preservedVaultDelta: 0,
        restoredVaultDelta,
      };
    }

    const steps = this.getStepsBetween(row.schemaVersion, targetVersion);
    let cells = createSafeRecord<CrdtCell>(Object.entries(row.cells).map(([name, cell]) => [name, { ...cell, hlc: canonicalHlc(cell.hlc) }]));
    let unmappedFields = createSafeRecord<UnmappedVaultEntry>(
      Object.entries(row.unmappedFields).map(([name, entry]) => [name, mergeVaultEntries(undefined, entry)])
    );
    let preservedVaultDelta = 0;
    let restoredVaultDelta = 0;

    for (const step of steps) {
      let operationSchema = this.getSchemaAtVersion(step.fromVersion);

      for (const [operationIndex, op] of step.operations.entries()) {
        if (op.table !== row.table) {
          continue;
        }
        const nextOperationSchema = evolveTableSchema(operationSchema, step.toVersion, [op]);

        switch (op.kind) {
          case 'add_column': {
            const colName = assertValidSqlIdentifier(op.column.name, 'column');
            if (
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
                ...sourceCell,
                value: validated,
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
              const lineage = this.lineageState(step.toVersion, operationIndex)[droppedCol];
              unmappedFields[droppedCol] = mergeVaultEntries(unmappedFields[droppedCol], {
                value: existingCell.value,
                hlc: existingCell.hlc,
                ...(Object.prototype.hasOwnProperty.call(existingCell, 'tieValue') && { tieValue: existingCell.tieValue }),
                sourceVersion: step.toVersion,
                schemaPosition: operationIndex,
                ...(lineage && { lineageId: lineage.id }),
              });
              delete cells[droppedCol];
              preservedVaultDelta += 1;
            }
            break;
          }

          case 'transform_column': {
            const colName = assertValidSqlIdentifier(op.column, 'transformed column');
            const existingCell = cells[colName];
            if (existingCell !== undefined) {
              const transformedValue = runMigrationTransform(op.transform, existingCell.value, op.fnName, op.column);
              const colSpec = nextOperationSchema.columns.find((c) => c.name === colName);
              const validated = assertSafeScalarValue(
                transformedValue,
                colName,
                colSpec?.type,
                colSpec?.nullable ?? true
              );
              cells[colName] = {
                ...existingCell,
                value: validated,
                tieValue: Object.prototype.hasOwnProperty.call(existingCell, 'tieValue') ? existingCell.tieValue! : existingCell.value,
              };
            }
            break;
          }
        }
        operationSchema = nextOperationSchema;
      }

      // Restore only after the complete step: future-form values must not run its transforms twice.
      restoredVaultDelta += this.reconcileVault(cells, unmappedFields, step.toVersion);
    }

    return {
      row: {
        pk: row.pk,
        table: row.table,
        schemaVersion: targetVersion,
      tombstoneHlc: row.tombstoneHlc === null ? null : canonicalHlc(row.tombstoneHlc),
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
    for (const [field, cell] of Object.entries(op.columns)) {
      if (Object.prototype.hasOwnProperty.call(cell, 'tieValue')) assertSafeScalarValue(cell.tieValue, `${field} tie value`);
    }
    for (const [field, entry] of Object.entries(op.unmappedFields ?? {})) validateVaultEntry(entry, field);
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
    const sourceLineages = op.schemaVersion <= this.maxVersion ? this.lineageState(op.schemaVersion) : null;
    const targetLineages = this.lineageState(targetVersion);
    const recognizedCells = createSafeRecord<CrdtCell>();
    const unmappedFields = createSafeRecord<UnmappedVaultEntry>(
      op.unmappedFields ? Object.entries(op.unmappedFields) : []
    );
    let preservedFutureFieldCount = 0;

    for (const [colName, cell] of Object.entries(op.columns)) {
      assertValidSqlIdentifier(colName, 'operation column');
      const lineage = sourceLineages?.[colName];
      const destination = lineage && Object.entries(targetLineages).find(([, candidate]) =>
        candidate.id === lineage.id && candidate.revision === lineage.revision
      );
      const targetName = op.schemaVersion === targetVersion
        ? colName
        : colName === targetSchema.primaryKey ? colName : destination?.[0];
      const colSpec = targetSchema.columns.find((c) => c.name === targetName);
      if (colSpec) {
        const validated = assertSafeScalarValue(
          cell.value,
          colSpec.name,
          colSpec.type,
          colSpec.nullable
        );
        recognizedCells[colSpec.name] = {
          ...cell,
          value: validated,
        };
      } else {
        unmappedFields[colName] = mergeVaultEntries(unmappedFields[colName], {
          value: assertSafeScalarValue(cell.value, colName),
          hlc: cell.hlc,
          ...(Object.prototype.hasOwnProperty.call(cell, 'tieValue') && { tieValue: cell.tieValue }),
          sourceVersion: op.schemaVersion,
          schemaPosition: 'end',
          ...(lineage && { lineageId: lineage.id }),
        });
        preservedFutureFieldCount += 1;
      }
    }

    // Vault entries already at or behind this schema can be reconciled even when
    // the operation itself did not require a schema-version transition.
    this.reconcileVault(recognizedCells, unmappedFields, targetVersion);

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
    cells[k] = { ...v, hlc: canonicalHlc(v.hlc) };
  }
  const unmappedFields = createSafeRecord<UnmappedVaultEntry>();
  for (const [k, v] of Object.entries(row.unmappedFields)) {
    unmappedFields[k] = mergeVaultEntries(undefined, v);
  }
  return {
    pk: row.pk,
    table: row.table,
    schemaVersion: row.schemaVersion,
    tombstoneHlc: row.tombstoneHlc === null ? null : canonicalHlc(row.tombstoneHlc),
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
  migrationPlan: readonly SqlMigrationPlanStep[];
}): MigrationReport {
  return Object.freeze({ ...params });
}

