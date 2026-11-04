export type ScalarValue = string | number | boolean | null;

export type ColumnDataType = 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN' | 'JSON';

export type SqlDialect = 'sqlite' | 'postgres';

export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnDataType;
  readonly nullable: boolean;
  readonly defaultValue?: ScalarValue;
}

export interface TableSchema {
  readonly tableName: string;
  readonly version: number;
  readonly primaryKey: string;
  readonly columns: readonly ColumnSpec[];
}

export interface AddColumnOperation {
  readonly kind: 'add_column';
  readonly table: string;
  readonly column: ColumnSpec;
  readonly backfillFromColumn?: string;
}

export interface RenameColumnOperation {
  readonly kind: 'rename_column';
  readonly table: string;
  readonly from: string;
  readonly to: string;
}

export interface DropColumnToVaultOperation {
  readonly kind: 'drop_column_to_vault';
  readonly table: string;
  readonly column: string;
}

export interface TransformColumnOperation {
  readonly kind: 'transform_column';
  readonly table: string;
  readonly column: string;
  readonly targetType?: ColumnDataType;
  readonly fnName: string;
  readonly transform: (
    value: ScalarValue,
    row: Readonly<Record<string, ScalarValue>>
  ) => ScalarValue;
}

export type MigrationOperation =
  | AddColumnOperation
  | RenameColumnOperation
  | DropColumnToVaultOperation
  | TransformColumnOperation;

export interface MigrationStep {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly description: string;
  readonly operations: readonly MigrationOperation[];
}

export interface ParsedHLC {
  readonly wallTimeMs: number;
  readonly counter: number;
  readonly nodeId: string;
}

export interface CrdtCell {
  readonly value: ScalarValue;
  readonly hlc: string;
}

export interface UnmappedVaultEntry {
  readonly value: ScalarValue;
  readonly hlc: string;
  readonly sourceVersion: number;
}

export interface CrdtRowState {
  readonly pk: string;
  readonly table: string;
  readonly schemaVersion: number;
  readonly tombstoneHlc: string | null;
  readonly cells: Record<string, CrdtCell>;
  readonly unmappedFields: Record<string, UnmappedVaultEntry>;
}

export interface CrdtChangeOperation {
  readonly opId: string;
  readonly table: string;
  readonly pk: string;
  readonly schemaVersion: number;
  readonly hlc: string;
  readonly nodeId: string;
  readonly kind: 'upsert' | 'delete';
  readonly columns: Record<string, CrdtCell>;
  readonly unmappedFields?: Record<string, UnmappedVaultEntry>;
}

export interface SyncPlaintextPayload {
  readonly protocolVersion: 1;
  readonly envelopeId: string;
  readonly nodeId: string;
  readonly table: string;
  readonly schemaVersion: number;
  readonly minHlc: string;
  readonly maxHlc: string;
  readonly operations: readonly CrdtChangeOperation[];
}

export interface EncryptedSyncEnvelope {
  readonly envelopeId: string;
  readonly protocolVersion: 1;
  readonly nodeId: string;
  readonly table: string;
  readonly schemaVersion: number;
  readonly minHlc: string;
  readonly maxHlc: string;
  readonly operationCount: number;
  readonly payloadSha256: string;
  readonly kdfSaltBase64: string;
  readonly kdfIterations: number;
  readonly ivBase64: string;
  readonly ciphertextBase64: string;
  readonly createdAtIso: string;
}

export interface ConflictResolutionEvent {
  readonly table: string;
  readonly pk: string;
  readonly column: string;
  readonly winnerHlc: string;
  readonly loserHlc: string;
  readonly winnerValue: ScalarValue;
  readonly loserValue: ScalarValue;
  readonly reason: string;
}

export interface MigrationReport {
  readonly table: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migratedRowCount: number;
  readonly upcastedOutboxCount: number;
  readonly preservedVaultFieldCount: number;
  readonly restoredFromVaultFieldCount: number;
  readonly generatedSql: readonly string[];
}

export interface SyncCycleReport {
  readonly pushedEnvelopeId: string | null;
  readonly pushedOperationCount: number;
  readonly pulledEnvelopeIds: readonly string[];
  readonly appliedOperationCount: number;
  readonly upcastedIncomingCount: number;
  readonly preservedFutureFieldCount: number;
  readonly conflictsResolved: readonly ConflictResolutionEvent[];
}

export interface StorageAdapter {
  readonly name: string;
  putEnvelope(envelope: EncryptedSyncEnvelope): Promise<void>;
  getEnvelope(envelopeId: string): Promise<EncryptedSyncEnvelope | null>;
  listEnvelopeIds(table?: string): Promise<readonly string[]>;
  deleteEnvelope(envelopeId: string): Promise<void>;
}

