# Rails for Local-First (`railsforlocalfirst`)

A lightweight, open-source sync and deterministic schema migration engine for SQLite/PostgreSQL local-first applications.

## The Problem It Solves

Building local-first software (using SQLite/IndexedDB on the client + CRDTs) hits a wall as soon as your database schema evolves and a user opens the app after being offline for months:
- Local rows and queued offline CRDT mutations are stuck on an older schema (`v1`), while online peers have already migrated to `v3`.
- Naive migrations either lose data on dropped/renamed columns or overwrite newer peer edits with synthetic migration defaults.
- Syncing over user-owned cloud storage (S3, iCloud Drive, Google Drive) exposes metadata and payloads unless authenticated End-to-End Encryption (E2EE) binds envelope headers to ciphertexts.

## Core Capabilities

1. **Deterministic Offline Schema Migration & Lens Upcasting (`src/engine/migrator.ts`)**
   - Evolves local CRDT tables across multi-step migrations (`add_column`, `rename_column`, `drop_column_to_vault`, `transform_column`) with **atomic snapshot rollback** on any error.
   - Automatically upcasts queued offline CRDT outbox mutations from `v1 -> vN` before syncing.
   - Uses epoch-zero HLC (`000000000000000:0000:schema-default`) for schema defaults so explicit user edits from any peer always beat synthetic migration defaults.
   - **Forward-Compatibility Vault (`_unmapped_vault`)**: Preserves dropped or unrecognized future columns (when a `v1` client receives a `v3` peer update before upgrading) and restores them automatically upon schema upgrade.

2. **Join-Semilattice Column-Level CRDT + Hybrid Logical Clock (`src/engine/crdt.ts`, `src/engine/hlc.ts`)**
   - Monotonic Hybrid Logical Clock (`<15-digit-wallTimeMs>:<4-hex-counter>:<nodeId>`) with configurable maximum drift bounds (`maxDriftMs`) to block rogue future-clock poisoning attacks.
   - Commutative, associative, and idempotent LWW register resolution per column and tombstone register for deletions.

3. **Authenticated E2EE BYO-Storage Sync (`src/engine/crypto.ts`, `src/engine/storage.ts`)**
   - Encrypts sync batches using WebCrypto `AES-256-GCM` with 96-bit CSPRNG IVs, 128-bit authentication tags, and `PBKDF2-SHA256` (`210,000` default iterations).
   - Binds `protocolVersion`, `envelopeId`, `nodeId`, `table`, `schemaVersion`, `minHlc`, `maxHlc`, `operationCount`, and `payloadSha256` into the AES-GCM **Additional Authenticated Data (AAD)** to prevent header tampering, replay, or schema-downgrade attacks.

4. **SQLite & PostgreSQL Parameterized Compiler (`src/engine/schema.ts`)**
   - Strict regex/keyword validation on all SQL identifiers (`assertValidSqlIdentifier`) and 100% parameterized queries (`?` for SQLite, `$1..$n` for PostgreSQL).

---

## Security & Safety Guarantees

- **Zero SQL Injection**: Identifiers are strictly allowlisted (`/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/`) and checked against reserved SQL keywords; runtime values are bound parameters.
- **Prototype Pollution Defense**: `safeJsonParse` and `assertNoPrototypePollution` reject `__proto__`, `constructor`, and `prototype` keys at every boundary.
- **SSRF & Path Traversal Protection**: BYO-Storage configuration blocks non-HTTPS endpoints, embedded credentials, cloud metadata IPs (`169.254.169.254`), RFC1918 private networks, and `..` key traversal.
- **Strict Content Security Policy (CSP)**: Configured in `index.html` with `default-src 'self'; object-src 'none'`.

---

## Quickstart

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```
