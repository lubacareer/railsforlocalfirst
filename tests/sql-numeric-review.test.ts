import { describe, expect, it } from 'vitest';
import {
  CRDT_METADATA_COLUMNS, formatHlc, listLiveSqlRows,
  type SqlDatabaseAdapter, type TableSchema,
} from '../src/engine';

const hlc = formatHlc({ wallTimeMs: 1000, counter: 0, nodeId: 'source' });
const schemaFor = (type: 'INTEGER' | 'REAL'): TableSchema => ({
  tableName: 'items', version: 1, primaryKey: 'id', columns: [
    { name: 'id', type: 'TEXT', nullable: false },
    { name: 'value', type, nullable: false },
  ],
});

function rawDriver(value: string): SqlDatabaseAdapter {
  return {
    dialect: 'postgres',
    async withWriteTransaction(work) {
      return work({ async query(sql) {
        if (sql.includes('information_schema.columns')) return CRDT_METADATA_COLUMNS.map(name => ({ name }));
        return [{ id: 'one', value, _causal_version: 2, _schema_version: 1,
          _crdt_hlc: hlc, _column_hlcs: { id: hlc, value: hlc },
          _column_tie_values: {}, _unmapped_vault: {}, _tombstone_hlc: null }];
      } });
    },
  };
}

describe('SQL numeric driver strings', () => {
  it.each(['', ' ', ' 1', '1 ', '0x10', '1e2', '1e-324', '1.0', '9007199254740991.1',
    '9007199254740992', '-9007199254740992', 'NaN', 'Infinity', 'bad'])('rejects malformed or inexact INTEGER %j', async value => {
    await expect(listLiveSqlRows(rawDriver(value), schemaFor('INTEGER')))
      .rejects.toMatchObject({ code: 'INVALID_SQL_NUMERIC_VALUE' });
  });

  it.each(['0', '-0', '+17', '-42', '0007', '9007199254740991', '-9007199254740991'])('reads an exact PostgreSQL bigint string %j', async value => {
    const [row] = await listLiveSqlRows(rawDriver(value), schemaFor('INTEGER'));
    expect(row?.cells.value?.value).toBe(Number(BigInt(value)));
  });

  it.each(['', ' ', ' 1', '1 ', '0x10', 'NaN', 'Infinity', '-Infinity', '1e309', '1.2.3', '1e', 'bad'])('rejects malformed REAL %j', async value => {
    await expect(listLiveSqlRows(rawDriver(value), schemaFor('REAL')))
      .rejects.toMatchObject({ code: 'INVALID_SQL_NUMERIC_VALUE' });
  });

  it.each(['0', '-0', '+17.5', '-.25', '1.', '2e3', '-1.25E-2'])('reads finite decimal REAL %j', async value => {
    const [row] = await listLiveSqlRows(rawDriver(value), schemaFor('REAL'));
    expect(row?.cells.value?.value).toBe(Number(value));
  });
});
