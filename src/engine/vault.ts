import { compareHlc } from './hlc';
import { formatHlc, parseHlc } from './hlc';
import { assertSafeObjectKey, assertSafeScalarValue, assertValidSqlIdentifier, SafetyViolationError } from './safety';
import type { CrdtCell, ScalarValue, UnmappedVaultEntry } from './types';

/** Same scalar ordering used by all in-memory and persistence merges. */
export function compareScalarDeterministically(a: ScalarValue, b: ScalarValue): number {
  const rank = (v: ScalarValue): number => v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : 3;
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  const x = String(a), y = String(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

export function cellWins(candidate: CrdtCell, current: CrdtCell): boolean {
  const cmp = compareHlc(candidate.hlc, current.hlc);
  if (cmp !== 0) return cmp > 0;
  const candidateTie = Object.prototype.hasOwnProperty.call(candidate, 'tieValue') ? candidate.tieValue! : candidate.value;
  const currentTie = Object.prototype.hasOwnProperty.call(current, 'tieValue') ? current.tieValue! : current.value;
  const tie = compareScalarDeterministically(candidateTie, currentTie);
  return tie > 0 || (tie === 0 && compareScalarDeterministically(candidate.value, current.value) > 0);
}

/** Normalize the accepted lower-case counter spelling to its canonical form. */
export function canonicalHlc(hlc: string): string {
  return formatHlc(parseHlc(hlc));
}

/** Keep unproven legacy incarnations distinct until their provenance is explicitly mapped. */
export function vaultIdentity(entry: UnmappedVaultEntry): string {
  const provenance = [entry.lineageId ?? null, entry.sourceVersion, entry.schemaPosition ?? null];
  if (entry.lineageId === undefined && entry.schemaPosition === undefined) {
    // A legacy index is an order in a particular snapshot, not a durable identity.
    // Without provenance we cannot assume even different clocks describe the same
    // register, so retain every distinct value/clock/tie tuple.
    return JSON.stringify([...provenance, entry.value,
      Object.prototype.hasOwnProperty.call(entry, 'tieValue') ? [true, entry.tieValue] : [false],
      canonicalHlc(entry.hlc)]);
  }
  return JSON.stringify(provenance);
}

export function flattenVaultEntry(entry: UnmappedVaultEntry): UnmappedVaultEntry[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      (entry.alternatives !== undefined && !Array.isArray(entry.alternatives))) {
    throw new SafetyViolationError('INVALID_VAULT_ENTRY', 'Malformed vault entry or alternatives.');
  }
  const { alternatives, ...first } = entry;
  const result = [first];
  for (const item of alternatives ?? []) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.alternatives !== undefined) {
      throw new SafetyViolationError('INVALID_VAULT_ENTRY', 'Vault alternatives must be flat.');
    }
    const { alternatives: _ignored, ...flat } = item;
    result.push(flat);
  }
  return result;
}

export function validateVaultEntry(entry: UnmappedVaultEntry, field: string): void {
  assertValidSqlIdentifier(field, 'unmapped field');
  assertSafeObjectKey(field);
  for (const item of flattenVaultEntry(entry)) {
    assertSafeScalarValue(item.value, field);
    if (Object.prototype.hasOwnProperty.call(item, 'tieValue')) assertSafeScalarValue(item.tieValue, `${field} tie value`);
    compareHlc(item.hlc, item.hlc);
    if (!Number.isSafeInteger(item.sourceVersion) || item.sourceVersion < 1 ||
        (item.schemaPosition !== undefined && item.schemaPosition !== 'end' &&
          (!Number.isSafeInteger(item.schemaPosition) || item.schemaPosition < 0)) ||
        (item.lineageId !== undefined && (typeof item.lineageId !== 'string' || !/^[A-Za-z0-9:_-]{1,256}$/.test(item.lineageId)))) {
      throw new SafetyViolationError('INVALID_VAULT_ENTRY', 'Invalid vault lineage or schema position.');
    }
  }
}

/** Merge independent provenance registers without discarding an incompatible incarnation. */
export function mergeVaultEntries(a: UnmappedVaultEntry | undefined, b: UnmappedVaultEntry): UnmappedVaultEntry {
  const entries = new Map<string, UnmappedVaultEntry>();
  for (const raw of [...(a ? flattenVaultEntry(a) : []), ...flattenVaultEntry(b)]) {
    const entry = { ...raw, hlc: canonicalHlc(raw.hlc) };
    const identity = vaultIdentity(entry);
    const previous = entries.get(identity);
    if (!previous || cellWins(entry, previous)) entries.set(identity, entry);
  }
  const sorted = [...entries.entries()].sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0).map(([, entry]) => ({ ...entry }));
  const first = sorted[0]!;
  return sorted.length === 1 ? first : { ...first, alternatives: sorted.slice(1) };
}

export function packVaultEntries(entries: readonly UnmappedVaultEntry[]): UnmappedVaultEntry | undefined {
  let packed: UnmappedVaultEntry | undefined;
  for (const entry of entries) packed = mergeVaultEntries(packed, entry);
  return packed;
}
