import { describe, expect, it } from 'vitest';
import { formatHlc } from '../src/engine/hlc';
import { cloneRowState, SchemaMigrationRegistry } from '../src/engine/migrator';
import { flattenVaultEntry, mergeVaultEntries } from '../src/engine/vault';
import type { CrdtRowState, TableSchema, UnmappedVaultEntry } from '../src/engine/types';

const hlc = (ms: number) => formatHlc({ wallTimeMs: ms, counter: 0, nodeId: 'legacy' });
const legacy = (value: UnmappedVaultEntry['value'], ms: number): UnmappedVaultEntry => ({
  value, hlc: hlc(ms), sourceVersion: 1,
});
const schema: TableSchema = { tableName: 'items', version: 1, primaryKey: 'id', columns: [
  { name: 'id', type: 'TEXT', nullable: false },
  { name: 'value', type: 'INTEGER', nullable: false, defaultValue: 0 },
] };

describe('ambiguous legacy vault identity', () => {
  it('preserves distinct values, clocks, and tie metadata in either merge order, without duplication', () => {
    const first = { ...legacy(7, 7), alternatives: [legacy(8, 8), { ...legacy(7, 7), tieValue: null }] };
    const second = { ...legacy(7, 9), alternatives: [{ ...legacy(7, 7), tieValue: 0 }, legacy('7', 7)] };
    const merged = mergeVaultEntries(first, second);
    expect(merged).toEqual(mergeVaultEntries(second, first));
    expect(mergeVaultEntries(merged, merged)).toEqual(merged);
    expect(flattenVaultEntry(merged)).toHaveLength(6);
    expect(flattenVaultEntry(merged)).toEqual(expect.arrayContaining([
      legacy(7, 7), legacy(8, 8), legacy(7, 9), legacy('7', 7),
      { ...legacy(7, 7), tieValue: null }, { ...legacy(7, 7), tieValue: 0 },
    ]));
  });

  it('retains known-lineage last-writer-wins behavior', () => {
    const earlier = { ...legacy(1, 1), lineageId: 'v1:base:value', schemaPosition: 'end' as const };
    const later = { ...legacy(2, 2), lineageId: 'v1:base:value', schemaPosition: 'end' as const };
    expect(mergeVaultEntries(earlier, later)).toEqual(later);
    expect(mergeVaultEntries(later, earlier)).toEqual(later);
  });

  it('clones and explicitly maps each value without discarding unselected alternatives', () => {
    const registry = new SchemaMigrationRegistry(schema);
    const row: CrdtRowState = {
      table: 'items', pk: 'a', schemaVersion: 1, tombstoneHlc: null,
      cells: { id: { value: 'a', hlc: hlc(1) }, value: { value: 1, hlc: hlc(1) } },
      unmappedFields: { value: { ...legacy(7, 7), alternatives: [legacy(8, 8)] } },
    };
    const clone = cloneRowState(row);
    expect(flattenVaultEntry(clone.unmappedFields.value!)).toHaveLength(2);
    const firstIndex = flattenVaultEntry(clone.unmappedFields.value!).findIndex((item) => item.value === 7);
    const first = registry.mapLegacyVaultEntry(clone, 'value', firstIndex, 1, 'end');
    expect(first.cells.value?.value).toBe(7);
    expect(flattenVaultEntry(first.unmappedFields.value!)).toEqual([legacy(8, 8)]);
    const second = registry.mapLegacyVaultEntry(first, 'value', 0, 1, 'end');
    expect(second.cells.value?.value).toBe(8);
    expect(second.unmappedFields.value).toBeUndefined();
    expect(flattenVaultEntry(row.unmappedFields.value!)).toHaveLength(2);
  });
});

describe('lineage keys', () => {
  it.each(['__proto__', 'constructor', 'prototype'])('rejects unsafe rename targets (%s)', (to) => {
    expect(() => new SchemaMigrationRegistry(schema, [{
      fromVersion: 1, toVersion: 2, description: 'unsafe rename',
      operations: [{ kind: 'rename_column', table: 'items', from: 'value', to }],
    }])).toThrow();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
