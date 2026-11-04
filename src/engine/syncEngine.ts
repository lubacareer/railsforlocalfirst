import { CrdtTableStore, isRowTombstoned } from './crdt';
import { decryptSyncEnvelope, encryptSyncOperations } from './crypto';
import { compareHlc, HybridLogicalClock } from './hlc';
import { SchemaMigrationRegistry } from './migrator';
import {
  assertSafeScalarValue,
  assertValidNodeId,
  assertValidPrimaryKey,
  assertValidSqlIdentifier,
  createSafeRecord,
  SafetyViolationError,
} from './safety';
import { compileCreateTableSql, compileParameterizedUpsert } from './schema';
import type {
  ConflictResolutionEvent,
  CrdtCell,
  CrdtChangeOperation,
  CrdtRowState,
  EncryptedSyncEnvelope,
  MigrationReport,
  ScalarValue,
  SqlDialect,
  StorageAdapter,
  SyncCycleReport,
  TableSchema,
} from './types';

export interface LocalFirstSyncEngineOptions {
  readonly nodeId: string;
  readonly registry: SchemaMigrationRegistry;
  readonly initialActiveVersion?: number;
  readonly initialWallTimeMs?: number;
  readonly maxDriftMs?: number;
}

export class LocalFirstSyncEngine {
  private readonly nodeId: string;
  private readonly registry: SchemaMigrationRegistry;
  private readonly clock: HybridLogicalClock;
  private readonly store: CrdtTableStore;
  private outbox: CrdtChangeOperation[] = [];
  private readonly processedEnvelopeIds = new Set<string>();
  private opSequence = 0;
  private envelopeSequence = 0;

  constructor(options: LocalFirstSyncEngineOptions) {
    this.nodeId = assertValidNodeId(options.nodeId);
    this.registry = options.registry;
    this.clock = new HybridLogicalClock(
      this.nodeId,
      options.initialWallTimeMs ?? 0,
      options.maxDriftMs
    );
    this.store = new CrdtTableStore(
      this.registry,
      options.initialActiveVersion ?? this.registry.getLatestVersion()
    );
  }

  public getNodeId(): string {
    return this.nodeId;
  }

  public getTableName(): string {
    return this.store.getTableName();
  }

  public getCurrentVersion(): number {
    return this.store.getCurrentVersion();
  }

  public getCurrentSchema(): TableSchema {
    return this.store.getCurrentSchema();
  }

  public getPendingOutboxCount(): number {
    return this.outbox.length;
  }

  public getPendingOutbox(): readonly CrdtChangeOperation[] {
    return [...this.outbox];
  }

  public getConflictLog(): readonly ConflictResolutionEvent[] {
    return this.store.getConflictLog();
  }

  /**
   * Performs a local upsert mutation at the client's current active schema version
   * and queues the signed CRDT operation in the offline outbox.
   */
  public upsert(
    pk: string,
    values: Readonly<Record<string, ScalarValue>>,
    physicalTimeMs = Date.now()
  ): CrdtChangeOperation {
    assertValidPrimaryKey(pk);
    const schema = this.getCurrentSchema();
    const hlc = this.clock.now(physicalTimeMs);
    const cells = createSafeRecord<CrdtCell>();

    cells[schema.primaryKey] = {
      value: pk,
      hlc,
    };

    for (const [colName, rawVal] of Object.entries(values)) {
      assertValidSqlIdentifier(colName, 'column');
      if (colName === schema.primaryKey) {
        if (rawVal !== pk) {
          throw new SafetyViolationError(
            'PRIMARY_KEY_MISMATCH',
            `Primary key in values ("${String(rawVal)}") does not match pk argument ("${pk}").`
          );
        }
        continue;
      }

      const colSpec = schema.columns.find((c) => c.name === colName);
      if (!colSpec) {
        throw new SafetyViolationError(
          'UNKNOWN_COLUMN_FOR_SCHEMA_VERSION',
          `Column "${colName}" does not exist in "${schema.tableName}" at schema v${schema.version}.`
        );
      }

      const validated = assertSafeScalarValue(
        rawVal,
        colName,
        colSpec.type,
        colSpec.nullable
      );
      cells[colName] = {
        value: validated,
        hlc,
      };
    }

    this.opSequence += 1;
    const op: CrdtChangeOperation = {
      opId: `${this.nodeId}-op-${this.opSequence}`,
      table: schema.tableName,
      pk,
      schemaVersion: schema.version,
      hlc,
      nodeId: this.nodeId,
      kind: 'upsert',
      columns: cells,
    };

    this.store.applyOperation(op);
    this.outbox.push(op);
    return op;
  }

  /**
   * Records a local CRDT tombstone deletion and queues it in the offline outbox.
   */
  public delete(pk: string, physicalTimeMs = Date.now()): CrdtChangeOperation {
    assertValidPrimaryKey(pk);
    const schema = this.getCurrentSchema();
    const hlc = this.clock.now(physicalTimeMs);

    this.opSequence += 1;
    const op: CrdtChangeOperation = {
      opId: `${this.nodeId}-op-${this.opSequence}`,
      table: schema.tableName,
      pk,
      schemaVersion: schema.version,
      hlc,
      nodeId: this.nodeId,
      kind: 'delete',
      columns: createSafeRecord<CrdtCell>(),
    };

    this.store.applyOperation(op);
    this.outbox.push(op);
    return op;
  }

  /**
   * Upgrades the client's local database schema AND deterministically upcasts all
   * pending offline outbox operations to targetVersion with atomic rollback safety.
   */
  public migrateToVersion(
    targetVersion: number,
    dialect: SqlDialect = 'sqlite'
  ): MigrationReport {
    const { report, upcastedOutbox } = this.store.migrateStoreToVersion(
      targetVersion,
      this.outbox,
      dialect
    );
    this.outbox = [...upcastedOutbox];
    return report;
  }

  /**
   * Encrypts pending offline mutations using AES-256-GCM + AAD and uploads the
   * content-addressed envelope to the BYO storage adapter.
   */
  public async pushToStorage(
    storage: StorageAdapter,
    passphrase: string,
    kdfIterations?: number
  ): Promise<EncryptedSyncEnvelope | null> {
    if (this.outbox.length === 0) {
      return null;
    }

    this.envelopeSequence += 1;
    const envelopeId = `env-${this.nodeId}-v${this.getCurrentVersion()}-${this.envelopeSequence}`;

    const envelope = await encryptSyncOperations({
      envelopeId,
      nodeId: this.nodeId,
      table: this.getTableName(),
      schemaVersion: this.getCurrentVersion(),
      operations: this.outbox,
      passphrase,
      kdfIterations,
    });

    await storage.putEnvelope(envelope);
    this.processedEnvelopeIds.add(envelopeId);
    this.outbox = [];
    return envelope;
  }

  /**
   * Pulls, decrypts, verifies, and applies unseen remote envelopes from the BYO storage adapter.
   * Automatically upcasts older schema envelopes and preserves unrecognized future schema fields.
   */
  public async pullFromStorage(
    storage: StorageAdapter,
    passphrase: string,
    physicalTimeMs = Date.now()
  ): Promise<{
    readonly pulledEnvelopeIds: readonly string[];
    readonly appliedOperationCount: number;
    readonly upcastedIncomingCount: number;
    readonly preservedFutureFieldCount: number;
    readonly conflictsResolved: readonly ConflictResolutionEvent[];
  }> {
    const envelopeIds = await storage.listEnvelopeIds(this.getTableName());
    const pulledEnvelopeIds: string[] = [];
    let appliedOperationCount = 0;
    let upcastedIncomingCount = 0;
    let preservedFutureFieldCount = 0;
    const conflictsResolved: ConflictResolutionEvent[] = [];

    for (const envId of envelopeIds) {
      if (this.processedEnvelopeIds.has(envId)) {
        continue;
      }

      const envelope = await storage.getEnvelope(envId);
      if (!envelope) {
        continue;
      }

      const payload = await decryptSyncEnvelope(envelope, passphrase);

      const preEnvelopeSnapshot = this.store.takeSnapshot();
      const preEnvelopeVersion = this.store.getCurrentVersion();
      const preClockState = this.clock.getState();

      try {
        // Advance local HLC against the remote envelope's maxHlc (validating drift bounds)
        this.clock.receive(payload.maxHlc, physicalTimeMs);

        for (const op of payload.operations) {
          this.clock.receive(op.hlc, physicalTimeMs);
          const result = this.store.applyOperation(op);
          if (result.applied) {
            appliedOperationCount += 1;
          }
          if (result.wasUpcasted) {
            upcastedIncomingCount += 1;
          }
          preservedFutureFieldCount += result.preservedFutureFieldCount;
          conflictsResolved.push(...result.conflicts);
        }
      } catch (err) {
        this.store.restoreSnapshot(preEnvelopeSnapshot, preEnvelopeVersion);
        this.clock.restoreState(preClockState);
        throw err;
      }

      this.processedEnvelopeIds.add(envId);
      pulledEnvelopeIds.push(envId);
    }

    return {
      pulledEnvelopeIds,
      appliedOperationCount,
      upcastedIncomingCount,
      preservedFutureFieldCount,
      conflictsResolved,
    };
  }

  /**
   * Executes a full bidirectional E2EE sync cycle (pull unseen peer envelopes, then push local outbox).
   */
  public async sync(
    storage: StorageAdapter,
    passphrase: string,
    physicalTimeMs = Date.now(),
    kdfIterations?: number
  ): Promise<SyncCycleReport> {
    const pullResult = await this.pullFromStorage(storage, passphrase, physicalTimeMs);
    const pushedCount = this.outbox.length;
    const pushedEnvelope = await this.pushToStorage(storage, passphrase, kdfIterations);

    return {
      pushedEnvelopeId: pushedEnvelope?.envelopeId ?? null,
      pushedOperationCount: pushedEnvelope ? pushedCount : 0,
      pulledEnvelopeIds: pullResult.pulledEnvelopeIds,
      appliedOperationCount: pullResult.appliedOperationCount,
      upcastedIncomingCount: pullResult.upcastedIncomingCount,
      preservedFutureFieldCount: pullResult.preservedFutureFieldCount,
      conflictsResolved: pullResult.conflictsResolved,
    };
  }

  public getRow(pk: string): Record<string, ScalarValue> | null {
    return this.store.getRow(pk);
  }

  public listRows(): readonly Record<string, ScalarValue>[] {
    return this.store.listRows();
  }

  public getRawRowState(pk: string): CrdtRowState | null {
    return this.store.getRawRowState(pk);
  }

  public listRawRowStates(): readonly CrdtRowState[] {
    return this.store.listRawRowStates();
  }

  public exportSqlSnapshot(dialect: SqlDialect): {
    readonly ddl: string;
    readonly upserts: readonly { readonly sql: string; readonly params: readonly ScalarValue[] }[];
  } {
    const schema = this.getCurrentSchema();
    const ddl = compileCreateTableSql(schema, dialect);
    const upserts = this.listRawRowStates()
      .filter((r) => !isRowTombstoned(r))
      .map((raw) => {
        const row = this.getRow(raw.pk)!;
        const cells = Object.values(raw.cells);
        const maxHlc = cells.reduce(
          (acc, cell) => (acc === '' || compareHlc(cell.hlc, acc) > 0 ? cell.hlc : acc),
          ''
        );
        return compileParameterizedUpsert(
          schema,
          row,
          maxHlc,
          JSON.stringify(raw.unmappedFields),
          dialect
        );
      });

    return { ddl, upserts };
  }
}
