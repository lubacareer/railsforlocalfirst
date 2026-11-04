import { describe, expect, it } from 'vitest';
import {
  compareHlc,
  compileCreateTableSql,
  compileParameterizedInsert,
  CrdtTableStore,
  decryptSyncEnvelope,
  encryptSyncOperations,
  formatHlc,
  HybridLogicalClock,
  InMemoryByoStorageAdapter,
  LocalFirstSyncEngine,
  MIN_KDF_ITERATIONS,
  parseHlc,
   safeJsonParse,
  SafetyViolationError,
  SchemaMigrationRegistry,
  validateByoStorageConfig,
  type MigrationStep,
  type TableSchema,
} from '../src/engine';

const SCHEMA_V1: TableSchema = {
  tableName: 'tasks',
  version: 1,
  primaryKey: 'id',
  columns: [
    { name: 'id', type: 'TEXT', nullable: false },
    { name: 'title', type: 'TEXT', nullable: false, defaultValue: 'Untitled' },
    { name: 'estimate_hours', type: 'INTEGER', nullable: false, defaultValue: 1 },
    { name: 'legacy_tag', type: 'TEXT', nullable: true, defaultValue: null },
  ],
};

const MIGRATIONS_V1_TO_V3: readonly MigrationStep[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    description: 'Rename title -> summary, add priority, transform estimate_hours -> minutes',
    operations: [
      {
        kind: 'rename_column',
        table: 'tasks',
        from: 'title',
        to: 'summary',
      },
      {
        kind: 'add_column',
        table: 'tasks',
        column: {
          name: 'priority',
          type: 'TEXT',
          nullable: false,
          defaultValue: 'medium',
        },
      },
      {
        kind: 'transform_column',
        table: 'tasks',
        column: 'estimate_hours',
        fnName: 'hours_to_minutes',
        transform: (val) => (typeof val === 'number' ? val * 60 : 60),
      },
      {
        kind: 'rename_column',
        table: 'tasks',
        from: 'estimate_hours',
        to: 'estimate_minutes',
      },
    ],
  },
  {
    fromVersion: 2,
    toVersion: 3,
    description: 'Archive legacy_tag to vault and add owner_team',
    operations: [
      {
        kind: 'drop_column_to_vault',
        table: 'tasks',
        column: 'legacy_tag',
      },
      {
        kind: 'add_column',
        table: 'tasks',
        column: {
          name: 'owner_team',
          type: 'TEXT',
          nullable: false,
          defaultValue: 'platform',
        },
      },
    ],
  },
];

const TEST_PASSPHRASE = 'correct-horse-battery-staple-2026!';

describe('HybridLogicalClock (HLC)', () => {
  it('generates monotonically increasing timestamps even when physical clock regresses', () => {
    const clock = new HybridLogicalClock('node-alpha', 1_700_000_000_000);
    const t1 = clock.now(1_700_000_001_000);
    const t2 = clock.now(1_700_000_000_500); // regressed physical clock
    const t3 = clock.now(1_700_000_000_500);

    expect(compareHlc(t1, t2)).toBe(-1);
    expect(compareHlc(t2, t3)).toBe(-1);
    expect(parseHlc(t2).wallTimeMs).toBe(1_700_000_001_000);
    expect(parseHlc(t2).counter).toBe(1);
    expect(parseHlc(t3).counter).toBe(2);
  });

  it('rejects remote HLCs that exceed maximum allowed clock drift', () => {
    const clock = new HybridLogicalClock('node-alpha', 1_700_000_000_000, 60_000);
    const rogueFutureHlc = formatHlc({
      wallTimeMs: 1_700_000_120_000, // +120s > 60s maxDriftMs
      counter: 0,
      nodeId: 'rogue-node',
    });

    expect(() => clock.receive(rogueFutureHlc, 1_700_000_000_000)).toThrowError(
      SafetyViolationError
    );
  });
});

describe('Security & Safety Hardening', () => {
  it('blocks SQL injection identifiers and reserved SQL keywords', () => {
    expect(() =>
      compileCreateTableSql(
        {
          tableName: 'users; DROP TABLE tasks;--',
          version: 1,
          primaryKey: 'id',
          columns: [{ name: 'id', type: 'TEXT', nullable: false }],
        },
        'sqlite'
      )
    ).toThrowError(SafetyViolationError);

    expect(() =>
      compileCreateTableSql(
        {
          tableName: 'SELECT',
          version: 1,
          primaryKey: 'id',
          columns: [{ name: 'id', type: 'TEXT', nullable: false }],
        },
        'postgres'
      )
    ).toThrowError(SafetyViolationError);
  });

  it('blocks prototype pollution payloads in safeJsonParse', () => {
    expect(() => safeJsonParse('{"__proto__": {"polluted": true}}')).toThrowError(
      SafetyViolationError
    );
    expect(() => safeJsonParse('{"constructor": {"prototype": {}}}')).toThrowError(
      SafetyViolationError
    );
  });

  it('blocks SSRF, non-HTTPS endpoints, and path traversal in BYO-Storage configs', () => {
    expect(() =>
      validateByoStorageConfig({
        provider: 's3-compatible',
        bucketOrFolderName: 'valid-bucket',
        endpointUrl: 'http://s3.example.com', // Insecure HTTP
      })
    ).toThrowError(SafetyViolationError);

    expect(() =>
      validateByoStorageConfig({
        provider: 's3-compatible',
        bucketOrFolderName: 'valid-bucket',
        endpointUrl: 'https://169.254.169.254/latest/meta-data/', // Cloud metadata SSRF
      })
    ).toThrowError(SafetyViolationError);

    expect(() =>
      validateByoStorageConfig({
        provider: 'icloud-drive',
        bucketOrFolderName: '../traversal-attempt',
      })
    ).toThrowError(SafetyViolationError);
  });

  it('generates parameterized SQLite and PostgreSQL queries without raw value interpolation', () => {
    const sqliteUpsert = compileParameterizedInsert(
      SCHEMA_V1,
      {
        id: 'task-1',
        title: "O'Reilly'; DROP TABLE tasks;--",
        estimate_hours: 5,
        legacy_tag: null,
      },
      '001700000000000:0000:node-a',
      '{}',
      'sqlite',
      '{}'
    );
    expect(sqliteUpsert.sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    expect(sqliteUpsert.sql).not.toContain('DROP TABLE');
    expect(sqliteUpsert.params[1]).toBe("O'Reilly'; DROP TABLE tasks;--");

    const pgUpsert = compileParameterizedInsert(
      SCHEMA_V1,
      {
        id: 'task-1',
        title: 'Safe Title',
        estimate_hours: 5,
        legacy_tag: 'v1',
      },
      '001700000000000:0000:node-a',
      '{}',
      'postgres',
      '{}'
    );
    expect(pgUpsert.sql).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)');
  });
});

describe('Deterministic Offline Schema Migration & 4-Month Catch-Up Sync', () => {
  it('migrates a 4-month offline v1 client to v3, upcasts outbox ops, and converges with a v3 peer without data loss', async () => {
    const registry = new SchemaMigrationRegistry(SCHEMA_V1, MIGRATIONS_V1_TO_V3);
    const storage = new InMemoryByoStorageAdapter();
    const baseTime = 1_780_000_000_000;
    const oneYearDrift = 365 * 24 * 60 * 60 * 1000;

    const peerDesktop = new LocalFirstSyncEngine({
      nodeId: 'desktop-peer',
      registry,
      initialActiveVersion: 1,
      initialWallTimeMs: baseTime,
      maxDriftMs: oneYearDrift,
    });

    const peerMobileStale = new LocalFirstSyncEngine({
      nodeId: 'mobile-stale-peer',
      registry,
      initialActiveVersion: 1,
      initialWallTimeMs: baseTime,
      maxDriftMs: oneYearDrift,
    });

    // 1. Seed initial v1 record and sync both peers
    peerDesktop.upsert(
      'task-1',
      {
        title: 'Initial v1 Title',
        estimate_hours: 2,
        legacy_tag: 'important-v1-note',
      },
      baseTime + 1000
    );
    await peerDesktop.sync(storage, TEST_PASSPHRASE, baseTime + 2000, MIN_KDF_ITERATIONS);
    await peerMobileStale.sync(storage, TEST_PASSPHRASE, baseTime + 3000, MIN_KDF_ITERATIONS);

    expect(peerMobileStale.getRow('task-1')).toEqual({
      id: 'task-1',
      title: 'Initial v1 Title',
      estimate_hours: 2,
      legacy_tag: 'important-v1-note',
    });

    // 2. Mobile goes offline for 4 months (120 days) on v1 and updates title + estimate_hours
    const fourMonthsLater = baseTime + 120 * 24 * 60 * 60 * 1000;
    peerMobileStale.upsert(
      'task-1',
      {
        title: 'Updated Offline on v1',
        estimate_hours: 5,
        legacy_tag: 'important-v1-note',
      },
      fourMonthsLater
    );

    // 3. Meanwhile Desktop upgrades v1 -> v3 and updates priority + owner_team
    peerDesktop.migrateToVersion(3);
    peerDesktop.upsert(
      'task-1',
      {
        summary: 'Initial v1 Title',
        priority: 'urgent',
        estimate_minutes: 120,
        owner_team: 'firmware-team',
      },
      fourMonthsLater - 10_000 // 10 seconds before Mobile's offline edit to title/estimate
    );
    await peerDesktop.sync(
      storage,
      TEST_PASSPHRASE,
      fourMonthsLater - 5_000,
      MIN_KDF_ITERATIONS
    );

    // 4. Mobile upgrades locally v1 -> v3 before syncing
    const migReport = peerMobileStale.migrateToVersion(3);
    expect(migReport.fromVersion).toBe(1);
    expect(migReport.toVersion).toBe(3);
    expect(migReport.upcastedOutboxCount).toBe(1);
    expect(migReport.preservedVaultFieldCount).toBe(1);

    // 5. Bidirectional E2EE sync converges both peers
    await peerMobileStale.sync(
      storage,
      TEST_PASSPHRASE,
      fourMonthsLater + 5_000,
      MIN_KDF_ITERATIONS
    );
    await peerDesktop.sync(
      storage,
      TEST_PASSPHRASE,
      fourMonthsLater + 10_000,
      MIN_KDF_ITERATIONS
    );

    // Both peers converge to the exact same merged row:
    // - summary & estimate_minutes come from Mobile's newer offline v1 edit (5 hours -> 300 minutes!)
    // - priority & owner_team come from Desktop's v3 edit ('urgent', 'firmware-team')
    const expectedMerged = {
      id: 'task-1',
      summary: 'Updated Offline on v1',
      priority: 'urgent',
      estimate_minutes: 300,
      owner_team: 'firmware-team',
    };

    expect(peerMobileStale.getRow('task-1')).toEqual(expectedMerged);
    expect(peerDesktop.getRow('task-1')).toEqual(expectedMerged);

    // Verify dropped column legacy_tag is still preserved in _unmappedFields vault (zero data loss)
    const rawMobile = peerMobileStale.getRawRowState('task-1')!;
    expect(rawMobile.unmappedFields['legacy_tag']?.value).toBe('important-v1-note');
  });

  it('preserves future v3 fields on a v1 client and restores them when the v1 client later upgrades to v3', async () => {
    const registry = new SchemaMigrationRegistry(SCHEMA_V1, MIGRATIONS_V1_TO_V3);
    const storage = new InMemoryByoStorageAdapter();
    const baseTime = 1_785_000_000_000;

    const peerV3 = new LocalFirstSyncEngine({
      nodeId: 'peer-v3',
      registry,
      initialActiveVersion: 3,
      initialWallTimeMs: baseTime,
    });

    const peerStillOnV1 = new LocalFirstSyncEngine({
      nodeId: 'peer-still-v1',
      registry,
      initialActiveVersion: 1,
      initialWallTimeMs: baseTime,
    });

    peerV3.upsert(
      'task-future',
      {
        summary: 'Created on v3',
        priority: 'high',
        estimate_minutes: 180,
        owner_team: 'security-team',
      },
      baseTime + 1000
    );
    await peerV3.pushToStorage(storage, TEST_PASSPHRASE, MIN_KDF_ITERATIONS);

    // v1 client pulls the v3 envelope BEFORE upgrading its own schema!
    const pullResult = await peerStillOnV1.pullFromStorage(
      storage,
      TEST_PASSPHRASE,
      baseTime + 2000
    );
    expect(pullResult.preservedFutureFieldCount).toBeGreaterThan(0);

    // Now the v1 client upgrades to v3; the preserved future fields must materialize automatically
    const report = peerStillOnV1.migrateToVersion(3);
    expect(report.restoredFromVaultFieldCount).toBeGreaterThan(0);
    expect(peerStillOnV1.getRow('task-future')).toEqual({
      id: 'task-future',
      summary: 'Created on v3',
      priority: 'high',
      estimate_minutes: 180,
      owner_team: 'security-team',
    });
  });

  it('rolls back atomically if a migration transform throws an error', () => {
    const faultySteps: readonly MigrationStep[] = [
      {
        fromVersion: 1,
        toVersion: 2,
        description: 'Faulty transform that throws',
        operations: [
          {
            kind: 'transform_column',
            table: 'tasks',
            column: 'estimate_hours',
            fnName: 'faulty_fn',
            transform: (value) => {
              if (value === 7) throw new Error('Simulated transform failure');
              return value;
            },
          },
        ],
      },
    ];

    const registry = new SchemaMigrationRegistry(SCHEMA_V1, faultySteps);
    const engine = new LocalFirstSyncEngine({
      nodeId: 'atomic-rollback-peer',
      registry,
      initialActiveVersion: 1,
    });

    engine.upsert('task-safe', {
      title: 'Must Not Corrupt',
      estimate_hours: 7,
      legacy_tag: 'safe',
    });

    expect(() => engine.migrateToVersion(2)).toThrowError('Simulated transform failure');
    expect(engine.getCurrentVersion()).toBe(1);
    expect(engine.getRow('task-safe')).toEqual({
      id: 'task-safe',
      title: 'Must Not Corrupt',
      estimate_hours: 7,
      legacy_tag: 'safe',
    });
  });
});

describe('CRDT Semilattice Commutativity (Out-of-Order Delete & Upsert)', () => {
  it('converges to the exact same state regardless of operation arrival order', () => {
    const registry = new SchemaMigrationRegistry(SCHEMA_V1);
    const peerA = new LocalFirstSyncEngine({ nodeId: 'peer-a', registry });
    const peerB = new LocalFirstSyncEngine({ nodeId: 'peer-b', registry });

    const opCreate = peerA.upsert(
      'item-1',
      { title: 'Original', estimate_hours: 3, legacy_tag: 'v1' },
      1_700_000_010_000
    );
    const opDelete = peerA.delete('item-1', 1_700_000_020_000);
    const opResurrect = peerB.upsert(
      'item-1',
      { title: 'Resurrected', estimate_hours: 9, legacy_tag: 'v1' },
      1_700_000_030_000
    );

    const store1 = new CrdtTableStore(registry);
    const store2 = new CrdtTableStore(registry);

    // Order 1: create -> delete -> resurrect
    store1.applyOperation(opCreate);
    store1.applyOperation(opDelete);
    store1.applyOperation(opResurrect);

    // Order 2: resurrect -> create -> delete
    store2.applyOperation(opResurrect);
    store2.applyOperation(opCreate);
    store2.applyOperation(opDelete);

    expect(store1.getRow('item-1')).toEqual(store2.getRow('item-1'));
    expect(store1.getRow('item-1')?.['title']).toBe('Resurrected');
  });
});

describe('E2EE Cryptographic Verification (AES-256-GCM + AAD)', () => {
  it('rejects wrong passphrases, tampered ciphertexts, and modified AAD envelope headers', async () => {
    const registry = new SchemaMigrationRegistry(SCHEMA_V1);
    const engine = new LocalFirstSyncEngine({ nodeId: 'crypto-peer', registry });
    const op = engine.upsert('task-crypto', {
      title: 'Top Secret Spec',
      estimate_hours: 10,
      legacy_tag: 'classified',
    });

    const envelope = await encryptSyncOperations({
      envelopeId: 'env-crypto-1',
      nodeId: 'crypto-peer',
      table: 'tasks',
      schemaVersion: 1,
      operations: [op],
      passphrase: TEST_PASSPHRASE,
      kdfIterations: MIN_KDF_ITERATIONS,
    });

    // 1. Valid decryption succeeds
    const decrypted = await decryptSyncEnvelope(envelope, TEST_PASSPHRASE);
    expect(decrypted.operations).toHaveLength(1);

    // 2. Wrong passphrase fails authentication
    await expect(
      decryptSyncEnvelope(envelope, 'wrong-passphrase-attempt-12345')
    ).rejects.toThrowError(SafetyViolationError);

    // 3. Tampered AAD metadata header (schemaVersion modified without changing ciphertext) fails
    const headerTampered = {
      ...envelope,
      schemaVersion: 2,
    };
    await expect(decryptSyncEnvelope(headerTampered, TEST_PASSPHRASE)).rejects.toThrowError(
      SafetyViolationError
    );

    // 4. Tampered ciphertext fails authentication
    const flippedCiphertext =
      envelope.ciphertextBase64.slice(0, -4) +
      (envelope.ciphertextBase64.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const ciphertextTampered = {
      ...envelope,
      ciphertextBase64: flippedCiphertext,
    };
    await expect(
      decryptSyncEnvelope(ciphertextTampered, TEST_PASSPHRASE)
    ).rejects.toThrowError(SafetyViolationError);
  });
});
