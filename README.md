# Rails for Local-First (`railsforlocalfirst`)

A lightweight, open-source sync and deterministic schema migration engine for SQLite/PostgreSQL local-first applications.

## The Problem It Solves

Building local-first software (using SQLite/IndexedDB on the client + CRDTs) hits a wall as soon as your database schema evolves and a user opens the app after being offline for months:
- Local rows and queued offline CRDT mutations are stuck on an older schema (`v1`), while online peers have already migrated to `v3`.
- Naive migrations either lose data on dropped/renamed columns or overwrite newer peer edits with synthetic migration defaults.
- User-owned cloud storage (S3, iCloud Drive, Google Drive) can see envelope metadata. End-to-end encryption protects payloads and authenticates the visible headers.

## Core Capabilities

1. **Deterministic Offline Schema Migration & Lens Upcasting (`src/engine/migrator.ts`)**
   - Evolves in-memory CRDT tables across multi-step migrations (`add_column`, `rename_column`, `drop_column_to_vault`, `transform_column`) with snapshot rollback on an error. This does not execute database transactions; callers must provide durable persistence for rows and the outbox.
   - Automatically upcasts queued offline CRDT outbox mutations from `v1 -> vN` before syncing.
   - Uses epoch-zero HLC (`000000000000000:0000:schema-default`) for schema defaults so explicit user edits from any peer always beat synthetic migration defaults.
   - **Forward-Compatibility Vault (`_unmapped_vault`)**: Preserves incompatible and unknown future fields with their schema provenance. A field is restored only when its lineage is known. Reusing a dropped column name creates a new field unless `add_column.restoreFrom` explicitly identifies the archived lineage. Ambiguous legacy entries remain in the vault for explicit mapping.
   - `mapLegacyVaultEntry` maps an ambiguous entry on a single engine instance after the caller determines its provenance. Mapping is local-only: apply it to every persisted peer copy because vault removals are not currently synchronized.
   - Legacy entry indexes refer to the current vault snapshot and can change after merges. Primary keys must be TEXT and cannot be transformed by schema migrations.

2. **Join-Semilattice Column-Level CRDT + Hybrid Logical Clock (`src/engine/crdt.ts`, `src/engine/hlc.ts`)**
   - Monotonic Hybrid Logical Clock (`<15-digit-wallTimeMs>:<4-hex-counter>:<nodeId>`) with configurable maximum drift bounds (`maxDriftMs`) to block rogue future-clock poisoning attacks.
   - Commutative, associative, and idempotent LWW register resolution per column and tombstone register for deletions.
   - New cells preserve their original value as a tie-break key across transforms. Older data without this metadata uses its received value as the fallback, so its original tie order cannot always be recovered after a transform.

3. **Authenticated E2EE BYO-Storage Sync (`src/engine/crypto.ts`, `src/engine/storage.ts`)**
   - Encrypts sync batches using WebCrypto `AES-256-GCM` with 96-bit CSPRNG IVs, 128-bit authentication tags, and `PBKDF2-SHA256` (`210,000` default iterations).
   - Authenticates `protocolVersion`, `envelopeId`, `nodeId`, `table`, `schemaVersion`, `minHlc`, `maxHlc`, `operationCount`, and, in v3, `createdAtIso` as AES-GCM **Additional Authenticated Data (AAD)**. These fields and other envelope metadata remain visible to storage providers.
   - New envelopes use protocol v3. Existing v2 envelopes can be read, but their `createdAtIso` is unauthenticated and must not be trusted. Protocol v1 is unsupported; older clients cannot read v3 envelopes.
   - AAD does not prevent replay or rollback. Processed envelope IDs are suppressed only for the lifetime of one engine instance; the in-memory adapter refuses replacement of an existing ID but does not reject older valid envelopes. Older schema operations are upcast before application.
   - Pull and sync reports include rejected envelope IDs and error codes. Authentication failures are quarantined in memory; call `retryRejectedEnvelopes(id)` or `retryRejectedEnvelopes()` after correcting the passphrase or restoring an envelope. A user-provided migration transform that throws produces a retryable `MIGRATION_TRANSFORM_FAILED` rejection; local migrations throw `MigrationTransformError` with the original error as its cause.
   - Each push sends one bounded batch; call it again while the outbox is non-empty. Per-envelope storage read failures remain retryable. Ordinary errors are reported as `STORAGE_READ_FAILED`; `SafetyViolationError` failures retain their specific codes.

4. **SQLite & PostgreSQL CRDT Persistence (`src/engine/sqlStore.ts`)**
   - `exportSqlSnapshot` returns table DDL and full CRDT row states, including deleted rows. Use `mergeSqlRowState` with `createSqliteAdapter` or `createPostgresAdapter` to merge each state under a write transaction; use `listLiveSqlRows` to read non-deleted rows. The application supplies the database connection and persists its outbox separately.
   - `migrateSqlTable` executes registered migrations transactionally by upcasting and rebuilding engine-managed tables. Tables with unsupported dependencies require a custom migration. Snapshots missing causal metadata must be regenerated from live CRDT state; old SQL snapshots cannot recover missing tombstones or lineage.
   - SQL identifiers are validated and values are parameterized. Migration plans identify required application migration steps rather than presenting SQL alone as a complete migration.

---

## Security & Safety Guarantees

- **Zero SQL Injection**: Identifiers are strictly allowlisted (`/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/`) and checked against reserved SQL keywords; runtime values are bound parameters.
- **Prototype Pollution Defense**: `safeJsonParse` and `assertNoPrototypePollution` reject `__proto__`, `constructor`, and `prototype` keys at every boundary.
- **SSRF & Path Traversal Protection**: For S3-compatible storage, configuration validates the endpoint and blocks non-HTTPS URLs, embedded credentials, restricted literal IPs, and metadata hostnames. Storage keys are separately checked for `..` traversal. Endpoint hostname validation does not resolve DNS. A network adapter must validate every resolved address at connection time, including after redirects, and connect to the validated address to prevent DNS rebinding.
- **Content Security Policy (CSP)**: Production HTML contains a restrictive CSP meta tag; development HTML omits it for Vite. Configure the hosting layer to send `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`) as an HTTP response header: browsers ignore `frame-ancestors` in a meta tag.

---

## Quickstart

Install Node.js 20.19 or later in the 20.x series, or Node.js 22.12 or later, and use a modern browser. npm is included with Node.js. The demo uses in-memory storage and does not require a PostgreSQL server or cloud account.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

Open the local address printed by Vite. To run the PostgreSQL integration tests, point `TEST_POSTGRES_URL` at a disposable PostgreSQL database; CI provisions one automatically. The tests create and drop test tables.

## Performance benchmarks

Run `npm run benchmark` to measure representative CRDT merges, migration upcasts, and encrypted envelope creation. For Vitest's machine-readable output, run `npm run benchmark -- --outputJson benchmarks.json`. Each benchmark measures a different operation; compare its results over time on the same testbed rather than comparing different operations to one another.

The separate GitHub Actions benchmark workflow uploads its results as a workflow artifact. On `main` and same-repository pull requests, it also submits results to the public Bencher project `rails-for-local-first` when the repository secret `BENCHER_API_KEY` is configured with a project-scoped `bencher_run_` key. To use a different project, set the `BENCHER_PROJECT` repository variable to its slug. Create the key in Bencher and add it directly as a GitHub Actions secret; never commit or share the key. Fork pull requests run the benchmarks but do not receive or use the secret.

The initial results establish a baseline; no regression threshold is enabled. Benchmark measurements in the public Bencher project are public, and the free plan and CI usage are subject to their respective service limits.
