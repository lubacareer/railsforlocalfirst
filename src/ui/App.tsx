import React, { useState } from 'react';
import {
  InMemoryByoStorageAdapter,
  LocalFirstSyncEngine,
  SafetyViolationError,
  SchemaMigrationRegistry,
  type EncryptedSyncEnvelope,
  type MigrationStep,
  type ScalarValue,
  type SqlDialect,
  type TableSchema,
} from '../engine';

const INITIAL_TASKS_SCHEMA_V1: TableSchema = {
  tableName: 'engineering_tasks',
  version: 1,
  primaryKey: 'id',
  columns: [
    { name: 'id', type: 'TEXT', nullable: false },
    { name: 'title', type: 'TEXT', nullable: false, defaultValue: 'Untitled' },
    { name: 'estimate_hours', type: 'INTEGER', nullable: false, defaultValue: 1 },
    { name: 'legacy_notes', type: 'TEXT', nullable: true, defaultValue: null },
  ],
};

const MIGRATION_STEPS_V1_TO_V3: readonly MigrationStep[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    description: 'Rename title -> summary, add priority column, convert estimate_hours -> minutes',
    operations: [
      {
        kind: 'rename_column',
        table: 'engineering_tasks',
        from: 'title',
        to: 'summary',
      },
      {
        kind: 'add_column',
        table: 'engineering_tasks',
        column: {
          name: 'priority',
          type: 'TEXT',
          nullable: false,
          defaultValue: 'medium',
        },
      },
      {
        kind: 'transform_column',
        table: 'engineering_tasks',
        column: 'estimate_hours',
        fnName: 'hours_to_minutes',
        transform: (val) => (typeof val === 'number' ? val * 60 : 60),
      },
      {
        kind: 'rename_column',
        table: 'engineering_tasks',
        from: 'estimate_hours',
        to: 'estimate_minutes',
      },
    ],
  },
  {
    fromVersion: 2,
    toVersion: 3,
    description: 'Archive legacy_notes to forward-compatibility vault and add owner_team',
    operations: [
      {
        kind: 'drop_column_to_vault',
        table: 'engineering_tasks',
        column: 'legacy_notes',
      },
      {
        kind: 'add_column',
        table: 'engineering_tasks',
        column: {
          name: 'owner_team',
          type: 'TEXT',
          nullable: false,
          defaultValue: 'core-platform',
        },
      },
    ],
  },
];

const DEMO_PASSPHRASE = 'local-first-zero-data-loss-key-2026';

interface LogEntry {
  readonly id: number;
  readonly tone: 'info' | 'emerald' | 'rose';
  readonly message: string;
}

export function App(): React.ReactElement {
  const [dialect, setDialect] = useState<SqlDialect>('sqlite');
  const [busy, setBusy] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [logs, setLogs] = useState<readonly LogEntry[]>([
    {
      id: 1,
      tone: 'info',
      message:
        'Ready: Click "1. Seed & Diverge (4 Months Offline)" to simulate a stale v1 client and an upgraded v3 peer.',
    },
  ]);

  const [simState, setSimState] = useState<{
    readonly registry: SchemaMigrationRegistry;
    readonly storage: InMemoryByoStorageAdapter;
    readonly peerOnline: LocalFirstSyncEngine;
    readonly peerStale: LocalFirstSyncEngine;
  }>(() => createFreshSimulation());

  const [envelopes, setEnvelopes] = useState<readonly EncryptedSyncEnvelope[]>([]);
  const [tamperStatus, setTamperStatus] = useState<string | null>(null);

  function appendLog(tone: LogEntry['tone'], message: string): void {
    setLogs((prev) => [{ id: prev.length + 1, tone, message }, ...prev]);
  }

  function refreshSnapshots(current = simState): void {
    setEnvelopes(current.storage.inspectAllEnvelopes());
  }

  async function handleStep1Diverge(): Promise<void> {
    setBusy(true);
    setTamperStatus(null);
    try {
      const fresh = createFreshSimulation();
      const baseTime = 1_790_000_000_000;

      // Both peers start at v1 with a shared task
      fresh.peerOnline.upsert(
        'task-101',
        {
          title: 'Implement CRDT sync engine',
          estimate_hours: 4,
          legacy_notes: 'Initial spec from Q1 hardware board review',
        },
        baseTime
      );
      await fresh.peerOnline.sync(fresh.storage, DEMO_PASSPHRASE, baseTime + 100);
      await fresh.peerStale.sync(fresh.storage, DEMO_PASSPHRASE, baseTime + 200);

      // Peer Stale goes offline for 4 months (120 days) on Schema v1 and makes offline edits:
      const fourMonthsLater = baseTime + 120 * 24 * 60 * 60 * 1000;
      fresh.peerStale.upsert(
        'task-101',
        {
          title: 'Implement CRDT sync engine (Offline Field Edit)',
          estimate_hours: 8,
          legacy_notes: 'Updated notes while offline in factory site',
        },
        fourMonthsLater
      );
      fresh.peerStale.upsert(
        'task-202',
        {
          title: 'Calibrate STM32 sensor bus',
          estimate_hours: 3,
          legacy_notes: 'Created offline on v1 schema',
        },
        fourMonthsLater + 1000
      );

      // Meanwhile Peer Online upgrades v1 -> v3 and edits priority & owner_team
      fresh.peerOnline.migrateToVersion(3, dialect);
      fresh.peerOnline.upsert(
        'task-101',
        {
          summary: 'Implement CRDT sync engine',
          priority: 'critical',
          estimate_minutes: 240,
          owner_team: 'storage-sync',
        },
        fourMonthsLater - 30_000 // 30s before Peer Stale's title/estimate edit!
      );
      await fresh.peerOnline.pushToStorage(fresh.storage, DEMO_PASSPHRASE);

      setSimState(fresh);
      setStepIndex(1);
      refreshSnapshots(fresh);
      appendLog(
        'emerald',
        'Step 1 complete: Peer Online upgraded to v3 & pushed E2EE envelope. Peer Stale remained offline on v1 for 120 days with 2 queued v1 mutations.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleStep2MigrateAndSync(): Promise<void> {
    setBusy(true);
    try {
      const report = simState.peerStale.migrateToVersion(3, dialect);
      appendLog(
        'emerald',
        `Migrated Peer Stale v${report.fromVersion} -> v${report.toVersion}: ${report.migratedRowCount} local rows upgraded, ${report.upcastedOutboxCount} queued v1 outbox ops upcasted, ${report.preservedVaultFieldCount} dropped fields archived in _unmapped_vault.`
      );

      const syncStale = await simState.peerStale.sync(
        simState.storage,
        DEMO_PASSPHRASE,
        1_800_500_000_000
      );
      const syncOnline = await simState.peerOnline.sync(
        simState.storage,
        DEMO_PASSPHRASE,
        1_800_500_005_000
      );

      refreshSnapshots();
      setStepIndex(2);
      appendLog(
        'emerald',
        `Bidirectional E2EE sync complete: Both peers converged on Schema v3 (${syncStale.conflictsResolved.length + syncOnline.conflictsResolved.length} column-level LWW conflicts deterministically resolved, 0 data loss).`
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSimulateTamperAttack(): Promise<void> {
    setBusy(true);
    try {
      const all = simState.storage.inspectAllEnvelopes();
      if (all.length === 0) {
        appendLog('rose', 'No encrypted envelopes in storage yet. Run Step 1 first.');
        return;
      }
      const target = all[0]!;
      // Attacker attempts to downgrade schemaVersion in header (violating AAD binding)
      const tampered: EncryptedSyncEnvelope = {
        ...target,
        schemaVersion: 99,
      };
      simState.storage.unsafeOverwriteForTamperTest(target.envelopeId, tampered);

      const verifierPeer = new LocalFirstSyncEngine({
        nodeId: 'security-auditor-node',
        registry: simState.registry,
        initialActiveVersion: 3,
      });

      try {
        await verifierPeer.pullFromStorage(simState.storage, DEMO_PASSPHRASE);
      } catch (err) {
        // Restore untampered envelope after proving rejection
        simState.storage.unsafeOverwriteForTamperTest(target.envelopeId, target);
        if (err instanceof SafetyViolationError) {
          setTamperStatus(`Blocked: ${err.code} — ${err.message}`);
          appendLog(
            'emerald',
            `Security verification passed: Tampered storage envelope deterministically rejected (${err.code}).`
          );
          return;
        }
        throw err;
      }
    } finally {
      setBusy(false);
    }
  }

  function handleReset(): void {
    const fresh = createFreshSimulation();
    setSimState(fresh);
    setEnvelopes([]);
    setStepIndex(0);
    setTamperStatus(null);
    setLogs([
      {
        id: 1,
        tone: 'info',
        message: 'Simulation reset. Click Step 1 to begin.',
      },
    ]);
  }

  const onlineRows = simState.peerOnline.listRows();
  const staleRows = simState.peerStale.listRows();
  const staleRawStates = simState.peerStale.listRawRowStates();
  const migrationSql = simState.registry.compileSqlForRange(1, 3, dialect);
  const sqlSnapshot = simState.peerStale.exportSqlSnapshot(dialect);

  return (
    <div className="workbench-container">
      <header className="workbench-header">
        <div>
          <h1 className="workbench-title">Rails for Local-First</h1>
          <p className="workbench-subtitle">
            Deterministic Offline Schema Migration, Column-Level HLC CRDT &amp; AES-256-GCM
            BYO-Storage Sync Engine
          </p>
        </div>
        <div className="badge-group">
          <span className="status-badge emerald">AES-256-GCM + AAD</span>
          <span className="status-badge">PBKDF2 210k Iterations</span>
          <span className="status-badge amber">Zero-Data-Loss Vault</span>
        </div>
      </header>

      <section className="controls-bar" aria-label="Simulation Controls">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void handleStep1Diverge()}
        >
          1. Seed &amp; Diverge (4 Months Offline)
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || stepIndex < 1}
          onClick={() => void handleStep2MigrateAndSync()}
        >
          2. Upgrade Stale Client (v1 &rarr; v3) &amp; Sync E2EE
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy || envelopes.length === 0}
          onClick={() => void handleSimulateTamperAttack()}
        >
          3. Simulate Cloud Storage Tamper Attack
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => setDialect((d) => (d === 'sqlite' ? 'postgres' : 'sqlite'))}
        >
          SQL Dialect: {dialect.toUpperCase()}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={handleReset}>
          Reset
        </button>
      </section>

      {tamperStatus && (
        <div className="card" style={{ marginBottom: '1.25rem', borderColor: '#34d399' }} role="status">
          <strong>E2EE Tamper Guard Result:</strong> {tamperStatus}
        </div>
      )}

      <div className="grid-two">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Peer A — Online Desktop ({simState.peerOnline.getNodeId()})</h2>
            <span className="status-badge emerald">
              Schema v{simState.peerOnline.getCurrentVersion()} | Outbox:{' '}
              {simState.peerOnline.getPendingOutboxCount()}
            </span>
          </div>
          { renderRowTable(onlineRows) }
        </section>

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">
              Peer B — Stale Field Client ({simState.peerStale.getNodeId()})
            </h2>
            <span
              className={`status-badge ${
                simState.peerStale.getCurrentVersion() < 3 ? 'amber' : 'emerald'
              }`}
            >
              Schema v{simState.peerStale.getCurrentVersion()} | Outbox:{' '}
              {simState.peerStale.getPendingOutboxCount()}
            </span>
          </div>
          { renderRowTable(staleRows) }
          {staleRawStates.length > 0 && (
            <div style={{ marginTop: '0.75rem' }}>
              <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginBottom: '0.3rem' }}>
                Preserved Forward/Dropped Fields Vault (<code>_unmapped_vault</code>):
              </div>
              <pre className="code-block">
                {JSON.stringify(
                  staleRawStates.map((r) => ({
                    pk: r.pk,
                    unmappedFields: r.unmappedFields,
                  })),
                  null,
                  2
                )}
              </pre>
            </div>
          )}
        </section>
      </div>

      <div className="grid-two">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">
              Deterministic Schema &amp; Parameterized SQL ({dialect.toUpperCase()})
            </h2>
            <span className="status-badge">Injection-Safe Identifiers</span>
          </div>
          <pre className="code-block">
            {[
              sqlSnapshot.ddl,
              '',
              ...migrationSql,
              '',
              ...sqlSnapshot.upserts.map(
                (q) => `${q.sql}\n-- Bound Params: ${JSON.stringify(q.params)}`
              ),
            ].join('\n')}
          </pre>
        </section>

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">BYO-Storage Encrypted Envelopes ({envelopes.length})</h2>
            <span className="status-badge">{simState.storage.name}</span>
          </div>
          <pre className="code-block">
            {envelopes.length === 0
              ? '// No encrypted envelopes uploaded yet.'
              : JSON.stringify(envelopes, null, 2)}
          </pre>
        </section>
      </div>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Deterministic Audit &amp; Convergence Log</h2>
        </div>
        <ul className="log-list" aria-live="polite">
          {logs.map((entry) => (
            <li key={entry.id} className={`log-item ${entry.tone}`}>
              {entry.message}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function createFreshSimulation() {
  const registry = new SchemaMigrationRegistry(
    INITIAL_TASKS_SCHEMA_V1,
    MIGRATION_STEPS_V1_TO_V3
  );
  const storage = new InMemoryByoStorageAdapter({
    provider: 's3-compatible',
    bucketOrFolderName: 'localfirst-encrypted-vault',
    endpointUrl: 'https://s3.eu-central-1.amazonaws.com',
  });
  const peerOnline = new LocalFirstSyncEngine({
    nodeId: 'peer-online-desktop',
    registry,
    initialActiveVersion: 1,
    initialWallTimeMs: 1_790_000_000_000,
    maxDriftMs: 365 * 24 * 60 * 60 * 1000,
  });
  const peerStale = new LocalFirstSyncEngine({
    nodeId: 'peer-stale-mobile',
    registry,
    initialActiveVersion: 1,
    initialWallTimeMs: 1_790_000_000_000,
    maxDriftMs: 365 * 24 * 60 * 60 * 1000,
  });

  return { registry, storage, peerOnline, peerStale };
}

function renderRowTable(rows: readonly Record<string, ScalarValue>[]): React.ReactElement {
  if (rows.length === 0) {
    return <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No active rows stored.</div>;
  }
  const columns = Object.keys(rows[0]!);
  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col}>{col}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => (
          <tr key={String(row['id'] ?? idx)}>
            {columns.map((col) => (
              <td key={col}>{String(row[col] ?? 'NULL')}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

