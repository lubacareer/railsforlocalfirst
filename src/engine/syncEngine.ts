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
  RejectedEnvelope,
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
  private readonly quarantinedEnvelopeIds = new Set<string>();
  private pushInFlight: Promise<EncryptedSyncEnvelope | null> | null = null;
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
    // Wait for an earlier push before capturing this batch. A failed push leaves
    // its operations pending and does not prevent a subsequent caller retrying.
    while (this.pushInFlight) {
      try { await this.pushInFlight; } catch { /* next caller may retry */ }
    }
    if (this.outbox.length === 0) return null;

    // Copy cells as well as the array: callers can hold references to operations,
    // and migrations can replace queued operations while encryption is pending.
    const snapshot = this.outbox.map((op) => ({
      ...op,
      columns: createSafeRecord(Object.entries(op.columns).map(([name, cell]) => [name, { ...cell }])),
      ...(op.unmappedFields && {
        unmappedFields: createSafeRecord(
          Object.entries(op.unmappedFields).map(([name, entry]) => [name, { ...entry }])
        ),
      }),
    }));
    const sentOperations = new Map(snapshot.map((op) => [op.opId, JSON.stringify(op)]));
    const envelopeId = `env-${this.nodeId}-v${this.getCurrentVersion()}-${++this.envelopeSequence}`;
    const schemaVersion = this.getCurrentVersion();
    const push = (async () => {
      const envelope = await encryptSyncOperations({
        envelopeId,
        nodeId: this.nodeId,
        table: this.getTableName(),
        schemaVersion,
        operations: snapshot,
        passphrase,
        kdfIterations,
      });
      await storage.putEnvelope(envelope);
      this.processedEnvelopeIds.add(envelopeId);
      this.outbox = this.outbox.filter((op) => sentOperations.get(op.opId) !== JSON.stringify(op));
      return envelope;
    })();
    this.pushInFlight = push;
    try {
      return await push;
    } finally {
      if (this.pushInFlight === push) this.pushInFlight = null;
    }
  }

  /** Allow retry after correcting credentials or restoring a quarantined envelope. */
  public retryRejectedEnvelopes(envelopeId?: string): void {
    if (envelopeId === undefined) this.quarantinedEnvelopeIds.clear();
    else this.quarantinedEnvelopeIds.delete(envelopeId);
  }

  /** Pulls unseen envelopes. Rejected envelopes do not block later work. */
  public async pullFromStorage(
    storage: StorageAdapter,
    passphrase: string,
    physicalTimeMs = Date.now()
  ): Promise<{
    readonly pulledEnvelopeIds: readonly string[];
    readonly rejectedEnvelopes: readonly RejectedEnvelope[];
    readonly appliedOperationCount: number;
    readonly upcastedIncomingCount: number;
    readonly preservedFutureFieldCount: number;
    readonly conflictsResolved: readonly ConflictResolutionEvent[];
  }> {
    const envelopeIds = await storage.listEnvelopeIds(this.getTableName());
    const pulledEnvelopeIds: string[] = [];
    const rejectedEnvelopes: RejectedEnvelope[] = [];
    let appliedOperationCount = 0;
    let upcastedIncomingCount = 0;
    let preservedFutureFieldCount = 0;
    const conflictsResolved: ConflictResolutionEvent[] = [];

    for (const envId of envelopeIds) {
      if (this.processedEnvelopeIds.has(envId) || this.quarantinedEnvelopeIds.has(envId)) continue;

      let preEnvelopeSnapshot: ReturnType<CrdtTableStore['takeSnapshot']> | undefined;
      let preEnvelopeVersion = 0;
      let preClockState: ReturnType<HybridLogicalClock['getState']> | undefined;
      let preConflictCount = 0;
      let envelopeApplied = 0;
      let envelopeUpcasted = 0;
      let envelopePreserved = 0;
      const envelopeConflicts: ConflictResolutionEvent[] = [];
      try {
        const envelope = await storage.getEnvelope(envId);
        if (!envelope) continue;
        if (envelope.envelopeId !== envId) {
          throw new SafetyViolationError('ENVELOPE_ID_MISMATCH', 'Storage returned an envelope with a different ID.');
        }
        const payload = await decryptSyncEnvelope(envelope, passphrase);
        // Capture only after asynchronous I/O so rollback cannot discard a local
        // edit made while the envelope was being fetched or decrypted.
        preEnvelopeSnapshot = this.store.takeSnapshot();
        preEnvelopeVersion = this.store.getCurrentVersion();
        preClockState = this.clock.getState();
        preConflictCount = this.store.getConflictLog().length;
        this.clock.receive(payload.maxHlc, physicalTimeMs);
        for (const op of payload.operations) {
          if (!op || typeof op !== 'object' || (op.kind !== 'upsert' && op.kind !== 'delete') ||
              typeof op.opId !== 'string' || typeof op.table !== 'string' || typeof op.nodeId !== 'string' ||
              !Number.isSafeInteger(op.schemaVersion) || op.schemaVersion < 1 || !op.columns || typeof op.columns !== 'object' || Array.isArray(op.columns) ||
              (op.unmappedFields !== undefined && (!op.unmappedFields || typeof op.unmappedFields !== 'object' || Array.isArray(op.unmappedFields)))) {
            throw new SafetyViolationError('INVALID_SYNC_OPERATION', 'Malformed sync operation fields.');
          }
          this.clock.validateRemoteHlc(op.hlc, physicalTimeMs);
          if (compareHlc(op.hlc, payload.maxHlc) > 0) {
            throw new SafetyViolationError('HLC_EXCEEDS_ENVELOPE_MAX', 'Operation HLC exceeds the envelope maximum.');
          }
          for (const cell of [...Object.values(op.columns), ...Object.values(op.unmappedFields ?? {})]) {
            if (!cell || typeof cell !== 'object') {
              throw new SafetyViolationError('INVALID_SYNC_OPERATION', 'Malformed sync cell or vault entry.');
            }
            this.clock.validateRemoteHlc(cell.hlc, physicalTimeMs);
            if (compareHlc(cell.hlc, op.hlc) > 0) {
              throw new SafetyViolationError('HLC_EXCEEDS_OPERATION', 'Cell or vault HLC exceeds its operation HLC.');
            }
          }
          const result = this.store.applyOperation(op);
          if (result.applied) envelopeApplied++;
          if (result.wasUpcasted) envelopeUpcasted++;
          envelopePreserved += result.preservedFutureFieldCount;
          envelopeConflicts.push(...result.conflicts);
        }
        this.processedEnvelopeIds.add(envId);
        pulledEnvelopeIds.push(envId);
        appliedOperationCount += envelopeApplied;
        upcastedIncomingCount += envelopeUpcasted;
        preservedFutureFieldCount += envelopePreserved;
        conflictsResolved.push(...envelopeConflicts);
      } catch (err) {
        if (preEnvelopeSnapshot && preClockState) {
          this.store.restoreSnapshot(preEnvelopeSnapshot, preEnvelopeVersion);
          this.store.truncateConflictLog(preConflictCount);
          this.clock.restoreState(preClockState);
        }
        if (!(err instanceof SafetyViolationError)) throw err;
        rejectedEnvelopes.push({ envelopeId: envId, errorCode: err.code });
        if (err.code === 'CRYPTO_AUTHENTICATION_FAILED' || err.code === 'PAYLOAD_HASH_MISMATCH') {
          this.quarantinedEnvelopeIds.add(envId);
        }
      }
    }

    return { pulledEnvelopeIds, rejectedEnvelopes, appliedOperationCount,
      upcastedIncomingCount, preservedFutureFieldCount, conflictsResolved };
  }

  /** Executes a bidirectional sync cycle. */
  public async sync(
    storage: StorageAdapter,
    passphrase: string,
    physicalTimeMs = Date.now(),
    kdfIterations?: number
  ): Promise<SyncCycleReport> {
    const pullResult = await this.pullFromStorage(storage, passphrase, physicalTimeMs);
    const pushedEnvelope = await this.pushToStorage(storage, passphrase, kdfIterations);
    return {
      pushedEnvelopeId: pushedEnvelope?.envelopeId ?? null,
      pushedOperationCount: pushedEnvelope?.operationCount ?? 0,
      ...pullResult,
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
        const clocks = [
          ...Object.values(raw.cells).map((cell) => cell.hlc),
          ...Object.values(raw.unmappedFields).map((entry) => entry.hlc),
          ...(raw.tombstoneHlc === null ? [] : [raw.tombstoneHlc]),
        ];
        const maxHlc = clocks.reduce(
          (acc, hlc) => (acc === '' || compareHlc(hlc, acc) > 0 ? hlc : acc),
          ''
        );
        return compileParameterizedUpsert(
          schema,
          row,
          maxHlc,
          JSON.stringify(raw.unmappedFields),
          dialect,
          JSON.stringify(Object.fromEntries(Object.entries(raw.cells).map(([name, cell]) => [name, cell.hlc])))
        );
      });

    return { ddl, upserts };
  }
}
