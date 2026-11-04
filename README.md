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
   - **Forward-Compatibility Vault (`_unmapped_vault`)**: Preserves dropped or unrecognized future columns (when a `v1` client receives a `v3` peer update before upgrading) and restores them automatically upon schema upgrade.

2. **Join-Semilattice Column-Level CRDT + Hybrid Logical Clock (`src/engine/crdt.ts`, `src/engine/hlc.ts`)**
   - Monotonic Hybrid Logical Clock (`<15-digit-wallTimeMs>:<4-hex-counter>:<nodeId>`) with configurable maximum drift bounds (`maxDriftMs`) to block rogue future-clock poisoning attacks.
   - Commutative, associative, and idempotent LWW register resolution per column and tombstone register for deletions.

3. **Authenticated E2EE BYO-Storage Sync (`src/engine/crypto.ts`, `src/engine/storage.ts`)**
   - Encrypts sync batches using WebCrypto `AES-256-GCM` with 96-bit CSPRNG IVs, 128-bit authentication tags, and `PBKDF2-SHA256` (`210,000` default iterations).
   - Authenticates `protocolVersion`, `envelopeId`, `nodeId`, `table`, `schemaVersion`, `minHlc`, `maxHlc`, and `operationCount` as AES-GCM **Additional Authenticated Data (AAD)**, detecting changes to those headers. These fields and other envelope metadata remain visible to storage providers.
   - Protocol v2 removes the public plaintext hash. Protocol v1 envelopes are incompatible and must be regenerated; older clients cannot read v2 envelopes.
   - AAD does not prevent replay or rollback. Processed envelope IDs are suppressed only for the lifetime of one engine instance; the in-memory adapter refuses replacement of an existing ID but does not reject older valid envelopes. Older schema operations are upcast before application.
   - Pull and sync reports include rejected envelope IDs and error codes. Authentication failures are quarantined in memory; call `retryRejectedEnvelopes(id)` or `retryRejectedEnvelopes()` after correcting the passphrase or restoring an envelope.

4. **SQLite & PostgreSQL Parameterized Compiler (`src/engine/schema.ts`)**
   - Strict regex/keyword validation on all SQL identifiers (`assertValidSqlIdentifier`) and parameterized upsert values (`?` for SQLite, `$1..$n` for PostgreSQL). SQL migration plans may require application-side steps; SQL statements alone are not a complete migration when a plan includes those steps.
   - SQL snapshots store per-column HLCs in `_column_hlcs`. Snapshots created before this metadata was added must be regenerated; row-level HLCs cannot reconstruct per-column clocks. Execute every step returned by `compileMigrationPlan` transactionally, including application transform and type-change steps.

---

## Security & Safety Guarantees

- **Zero SQL Injection**: Identifiers are strictly allowlisted (`/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/`) and checked against reserved SQL keywords; runtime values are bound parameters.
- **Prototype Pollution Defense**: `safeJsonParse` and `assertNoPrototypePollution` reject `__proto__`, `constructor`, and `prototype` keys at every boundary.
- **SSRF & Path Traversal Protection**: BYO-Storage configuration blocks non-HTTPS endpoints, embedded credentials, restricted literal IPs and metadata hostnames, and `..` key traversal. This is hostname validation only; it does not resolve DNS. A network adapter must validate every resolved address at connection time, including after redirects, and connect to the validated address to prevent DNS rebinding.
- **Content Security Policy (CSP)**: Production HTML contains a restrictive CSP meta tag; development HTML omits it for Vite. Configure the hosting layer to send `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`) as an HTTP response header: browsers ignore `frame-ancestors` in a meta tag.

---

## Quickstart

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```
