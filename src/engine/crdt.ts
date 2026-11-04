import { compareHlc, parseHlc } from './hlc';
import { cloneRowState, MIGRATION_DEFAULT_HLC, SchemaMigrationRegistry } from './migrator';
import {
  assertSafeScalarValue,
  assertValidPrimaryKey,
  assertValidSqlIdentifier,
  createSafeRecord,
} from './safety';
import { defaultZeroForType } from './schema';
import type {
  ConflictResolutionEvent,
  CrdtCell,
  CrdtChangeOperation,
  CrdtRowState,
  MigrationReport,
  ScalarValue,
  SqlDialect,
  TableSchema,
  UnmappedVaultEntry,
} from './types';

/**
 * Computes whether a row is currently tombstoned (deleted).
 * Because both `tombstoneHlc` and each column's `cell.hlc` are monotonic LWW registers,
 * a row is deleted iff `tombstoneHlc !== null` and no column or unmapped field has a
 * strictly newer HLC than `tombstoneHlc`. This guarantees strict commutativity,
 * associativity, and idempotence across out-of-order delete and upsert operations.
 */
function compareScalarDeterministically(a: ScalarValue, b: ScalarValue): number {
  const rankType = (v: ScalarValue): number => {
    if (v === null) return 0;
    if (typeof v === 'boolean') return 1;
    if (typeof v === 'number') return 2;
    return 3;
  };
  const typeDiff = rankType(a) - rankType(b);
  if (typeDiff !== 0) return typeDiff;
  const strA = String(a);
  const strB = String(b);
  if (strA === strB) return 0;
  return strA < strB ? -1 : 1;
}

export function isRowTombstoned(state: CrdtRowState): boolean {
  if (state.tombstoneHlc === null) {
    return false;
  }
  for (const cell of Object.values(state.cells)) {
    if (compareHlc(cell.hlc, state.tombstoneHlc) > 0) {
      return false;
    }
  }
  for (const vault of Object.values(state.unmappedFields)) {
    if (compareHlc(vault.hlc, state.tombstoneHlc) > 0) {
      return false;
    }
  }
  return true;
}

export class CrdtTableStore {
  private readonly registry: SchemaMigrationRegistry;
  private currentVersion: number;
  private rows = new Map<string, CrdtRowState>();
  private conflictLog: ConflictResolutionEvent[] = [];

  constructor(registry: SchemaMigrationRegistry, initialActiveVersion?: number) {
    this.registry = registry;
    const version = initialActiveVersion ?? registry.getLatestVersion();
    this.registry.getSchemaAtVersion(version);
    this.currentVersion = version;
  }

  public getTableName(): string {
    return this.registry.getTableName();
  }

  public getCurrentVersion(): number {
    return this.currentVersion;
  }

  public getCurrentSchema(): TableSchema {
    return this.registry.getSchemaAtVersion(this.currentVersion);
  }

  public getConflictLog(): readonly ConflictResolutionEvent[] {
    return [...this.conflictLog];
  }

  /** Restore the conflict log after a rejected atomic operation. */
  public truncateConflictLog(length: number): void {
    this.conflictLog.length = length;
  }

  public takeSnapshot(): Map<string, CrdtRowState> {
    const snap = new Map<string, CrdtRowState>();
    for (const [pk, state] of this.rows.entries()) {
      snap.set(pk, cloneRowState(state));
    }
    return snap;
  }

  public restoreSnapshot(snapshot: Map<string, CrdtRowState>, version: number): void {
    this.registry.getSchemaAtVersion(version);
    const restored = new Map<string, CrdtRowState>();
    for (const [pk, state] of snapshot.entries()) {
      restored.set(pk, cloneRowState(state));
    }
    this.rows = restored;
    this.currentVersion = version;
  }

  /**
   * Applies a local or remote CRDT operation deterministically using a join-semilattice:
   * - Column-level Last-Write-Wins (LWW) registers ordered by Hybrid Logical Clock (HLC).
   * - Monotonic tombstone register for deletions that commutes with out-of-order upserts.
   */
  public applyOperation(rawOp: CrdtChangeOperation): {
    readonly applied: boolean;
    readonly wasUpcasted: boolean;
    readonly preservedFutureFieldCount: number;
    readonly conflicts: readonly ConflictResolutionEvent[];
  } {
    assertValidPrimaryKey(rawOp.pk);
    parseHlc(rawOp.hlc);

    const { operation: op, wasUpcasted, preservedFutureFieldCount } =
      this.registry.normalizeChangeOperation(rawOp, this.currentVersion);

    const schema = this.getCurrentSchema();
    const existing = this.rows.get(op.pk);
    const conflicts: ConflictResolutionEvent[] = [];

    const baseRow: CrdtRowState = existing
      ? cloneRowState(existing)
      : this.createDefaultRowSkeleton(op.pk, schema);

    if (op.kind === 'delete') {
      if (baseRow.tombstoneHlc === null || compareHlc(op.hlc, baseRow.tombstoneHlc) > 0) {
        this.rows.set(op.pk, {
          ...baseRow,
          tombstoneHlc: op.hlc,
        });
        return { applied: true, wasUpcasted, preservedFutureFieldCount, conflicts };
      }
      if (!existing) {
        this.rows.set(op.pk, baseRow);
      }
      return { applied: false, wasUpcasted, preservedFutureFieldCount, conflicts };
    }

    // Upsert operation
    let anyCellUpdated = !existing;

    for (const [colName, incomingCell] of Object.entries(op.columns)) {
      assertValidSqlIdentifier(colName, 'column');
      parseHlc(incomingCell.hlc);

      const colSpec = schema.columns.find((c) => c.name === colName);
      if (!colSpec) {
        const safeVal = assertSafeScalarValue(incomingCell.value, colName);
        const existingVault = baseRow.unmappedFields[colName];
        const vaultCmp = existingVault ? compareHlc(incomingCell.hlc, existingVault.hlc) : 1;
        if (
          !existingVault ||
          vaultCmp > 0 ||
          (vaultCmp === 0 && compareScalarDeterministically(safeVal, existingVault.value) > 0)
        ) {
          baseRow.unmappedFields[colName] = {
            value: safeVal,
            hlc: incomingCell.hlc,
            sourceVersion: op.schemaVersion,
          };
          anyCellUpdated = true;
        }
        continue;
      }

      const validatedValue = assertSafeScalarValue(
        incomingCell.value,
        colName,
        colSpec.type,
        colSpec.nullable
      );

      const currentCell = baseRow.cells[colName];
      if (!currentCell) {
        baseRow.cells[colName] = {
          value: validatedValue,
          hlc: incomingCell.hlc,
        };
        anyCellUpdated = true;
        continue;
      }

      const cmp = compareHlc(incomingCell.hlc, currentCell.hlc);
      const winsOnTie =
        cmp === 0 && compareScalarDeterministically(validatedValue, currentCell.value) > 0;
      if (cmp > 0 || winsOnTie) {
        if (
          existing &&
          currentCell.hlc !== MIGRATION_DEFAULT_HLC &&
          currentCell.hlc !== incomingCell.hlc &&
          currentCell.value !== validatedValue
        ) {
          const event: ConflictResolutionEvent = {
            table: schema.tableName,
            pk: op.pk,
            column: colName,
            winnerHlc: incomingCell.hlc,
            loserHlc: currentCell.hlc,
            winnerValue: validatedValue,
            loserValue: currentCell.value,
            reason: `Incoming HLC (${incomingCell.hlc}) > existing HLC (${currentCell.hlc})`,
          };
          conflicts.push(event);
          this.conflictLog.push(event);
        }
        baseRow.cells[colName] = {
          value: validatedValue,
          hlc: incomingCell.hlc,
        };
        anyCellUpdated = true;
      } else if (cmp < 0 && existing && currentCell.value !== validatedValue) {
        const event: ConflictResolutionEvent = {
          table: schema.tableName,
          pk: op.pk,
          column: colName,
          winnerHlc: currentCell.hlc,
          loserHlc: incomingCell.hlc,
          winnerValue: currentCell.value,
          loserValue: validatedValue,
          reason: `Existing HLC (${currentCell.hlc}) > incoming HLC (${incomingCell.hlc})`,
        };
        conflicts.push(event);
        this.conflictLog.push(event);
      }
    }

    if (op.unmappedFields) {
      for (const [fieldKey, vaultEntry] of Object.entries(op.unmappedFields)) {
        assertValidSqlIdentifier(fieldKey, 'unmapped field');
        parseHlc(vaultEntry.hlc);
        const safeVal = assertSafeScalarValue(vaultEntry.value, fieldKey);
        const currentVault = baseRow.unmappedFields[fieldKey];
        const vaultCmp = currentVault ? compareHlc(vaultEntry.hlc, currentVault.hlc) : 1;
        if (
          !currentVault ||
          vaultCmp > 0 ||
          (vaultCmp === 0 && compareScalarDeterministically(safeVal, currentVault.value) > 0)
        ) {
          baseRow.unmappedFields[fieldKey] = {
            value: safeVal,
            hlc: vaultEntry.hlc,
            sourceVersion: vaultEntry.sourceVersion,
          };
          anyCellUpdated = true;
        }
      }
    }

    this.rows.set(op.pk, baseRow);
    return { applied: anyCellUpdated, wasUpcasted, preservedFutureFieldCount, conflicts };
  }

  /**
   * Runs an atomic, snapshot-protected schema migration of all stored rows
   * and queued outbox operations to targetVersion.
   */
  public migrateStoreToVersion(
    targetVersion: number,
    pendingOutbox: readonly CrdtChangeOperation[],
    dialect: SqlDialect = 'sqlite'
  ): {
    readonly report: MigrationReport;
    readonly upcastedOutbox: readonly CrdtChangeOperation[];
  } {
    const fromVersion = this.currentVersion;
    const preMigrationSnapshot = this.takeSnapshot();

    try {
      const nextRows = new Map<string, CrdtRowState>();
      let preservedVaultFieldCount = 0;
      let restoredFromVaultFieldCount = 0;

      for (const [pk, rowState] of this.rows.entries()) {
        const { row, preservedVaultDelta, restoredVaultDelta } =
          this.registry.upcastRowState(rowState, targetVersion);
        nextRows.set(pk, row);
        preservedVaultFieldCount += preservedVaultDelta;
        restoredFromVaultFieldCount += restoredVaultDelta;
      }

      const upcastedOutbox: CrdtChangeOperation[] = [];
      let upcastedOutboxCount = 0;

      for (const op of pendingOutbox) {
        const { operation, wasUpcasted } = this.registry.normalizeChangeOperation(
          op,
          targetVersion
        );
        upcastedOutbox.push(operation);
        if (wasUpcasted) {
          upcastedOutboxCount += 1;
        }
      }

      const migrationPlan = this.registry.compileMigrationPlan(
        fromVersion,
        targetVersion,
        dialect
      );

      this.rows = nextRows;
      this.currentVersion = targetVersion;

      return {
        report: {
          table: this.getTableName(),
          fromVersion,
          toVersion: targetVersion,
          migratedRowCount: nextRows.size,
          upcastedOutboxCount,
          preservedVaultFieldCount,
          restoredFromVaultFieldCount,
          migrationPlan,
        },
        upcastedOutbox,
      };
    } catch (error) {
      // Atomic rollback to pre-migration snapshot on any failure
      this.restoreSnapshot(preMigrationSnapshot, fromVersion);
      throw error;
    }
  }

  public getRow(pk: string): Record<string, ScalarValue> | null {
    assertValidPrimaryKey(pk);
    const state = this.rows.get(pk);
    if (!state || isRowTombstoned(state)) {
      return null;
    }
    return this.materializeRow(state);
  }

  public listRows(): readonly Record<string, ScalarValue>[] {
    const result: Record<string, ScalarValue>[] = [];
    const sortedKeys = [...this.rows.keys()].sort();
    for (const pk of sortedKeys) {
      const state = this.rows.get(pk)!;
      if (!isRowTombstoned(state)) {
        result.push(this.materializeRow(state));
      }
    }
    return result;
  }

  public getRawRowState(pk: string): CrdtRowState | null {
    assertValidPrimaryKey(pk);
    const state = this.rows.get(pk);
    return state ? cloneRowState(state) : null;
  }

  public listRawRowStates(): readonly CrdtRowState[] {
    const sortedKeys = [...this.rows.keys()].sort();
    return sortedKeys.map((pk) => cloneRowState(this.rows.get(pk)!));
  }

  private materializeRow(state: CrdtRowState): Record<string, ScalarValue> {
    const schema = this.getCurrentSchema();
    const out = createSafeRecord<ScalarValue>();
    for (const col of schema.columns) {
      const cell = state.cells[col.name];
      if (cell !== undefined) {
        out[col.name] = cell.value;
      } else {
        out[col.name] =
          col.defaultValue !== undefined
            ? col.defaultValue
            : col.nullable
              ? null
              : defaultZeroForType(col.type);
      }
    }
    return out;
  }

  private createDefaultRowSkeleton(pk: string, schema: TableSchema): CrdtRowState {
    const cells = createSafeRecord<CrdtCell>();
    for (const col of schema.columns) {
      if (col.name === schema.primaryKey) {
        cells[col.name] = { value: pk, hlc: MIGRATION_DEFAULT_HLC };
      } else {
        const defaultVal =
          col.defaultValue !== undefined
            ? col.defaultValue
            : col.nullable
              ? null
              : defaultZeroForType(col.type);
        cells[col.name] = {
          value: defaultVal,
          hlc: MIGRATION_DEFAULT_HLC,
        };
      }
    }
    return {
      pk,
      table: schema.tableName,
      schemaVersion: this.currentVersion,
      tombstoneHlc: null,
      cells,
      unmappedFields: createSafeRecord<UnmappedVaultEntry>(),
    };
  }
}
