import { describe, expect, it } from 'vitest';
import { SchemaMigrationRegistry } from '../src/engine/migrator';
import { CrdtTableStore, mergeCrdtRowStates, isRowTombstoned } from '../src/engine/crdt';
import { formatHlc } from '../src/engine/hlc';
import { LocalFirstSyncEngine } from '../src/engine/syncEngine';
import { encryptSyncOperations, MIN_KDF_ITERATIONS } from '../src/engine/crypto';
import { InMemoryByoStorageAdapter } from '../src/engine/storage';
import { cellWins } from '../src/engine/vault';
import type { CrdtChangeOperation, CrdtRowState, MigrationStep, TableSchema } from '../src/engine/types';

const time = (n: number) => formatHlc({wallTimeMs:n, counter:0, nodeId:'node'});
const base: TableSchema = { tableName:'items', version:1, primaryKey:'id', columns:[
  {name:'id',type:'TEXT',nullable:false}, {name:'source',type:'INTEGER',nullable:false,defaultValue:0},
]};
const migrations: MigrationStep[] = [
  {fromVersion:1,toVersion:2,description:'add',operations:[{kind:'add_column',table:'items',column:{name:'estimate',type:'INTEGER',nullable:false,defaultValue:0},backfillFromColumn:'source'}]},
  {fromVersion:2,toVersion:3,description:'minutes',operations:[{kind:'transform_column',table:'items',column:'estimate',fnName:'convert',targetType:'TEXT',transform:v => String(Number(v)*60)}]},
];
function op(version:number, name:string, value:string|number, t:number): CrdtChangeOperation { return {
  opId:`op-${version}-${t}`, table:'items', pk:'a', schemaVersion:version, hlc:time(t),nodeId:'node',kind:'upsert',
  columns:{id:{value:'a',hlc:time(t)},[name]:{value,hlc:time(t)}},
}; }

describe('versioned vault migration', () => {
  it('keeps equal-HLC winner stable through an order-reversing transform', () => {
    const schema: TableSchema = {...base,columns:[...base.columns,{name:'label',type:'TEXT',nullable:false,defaultValue:''}]};
    const registry = new SchemaMigrationRegistry(schema,[{fromVersion:1,toVersion:2,description:'reverse ordering',operations:[
      {kind:'transform_column',table:'items',column:'label',fnName:'reverse',transform:v=>v === 'a' ? 'z' : v === 'b' ? 'a' : v},
    ]}]);
    const first = op(1,'label','a',10);
    const second = {...op(1,'label','b',10),opId:'other'};
    const mergeFirst = new CrdtTableStore(registry,1);
    mergeFirst.applyOperation(first);
    mergeFirst.applyOperation(second);
    mergeFirst.migrateStoreToVersion(2,[]);
    const migrateFirst = new CrdtTableStore(registry,2);
    migrateFirst.applyOperation(first);
    migrateFirst.applyOperation(second);
    expect(mergeFirst.getRawRowState('a')?.cells.label).toEqual(migrateFirst.getRawRowState('a')?.cells.label);
    expect(mergeFirst.getRow('a')?.label).toBe('a');
  });

  it('treats an explicit null tie value as distinct from absent legacy tie metadata', () => {
    expect(cellWins({value:'z',hlc:time(1),tieValue:null},{value:'a',hlc:time(1)})).toBe(false);
    expect(cellWins({value:'a',hlc:time(1)},{value:'z',hlc:time(1),tieValue:null})).toBe(true);
  });
  it.each(['same type', 'changed type'])('quarantines in-place future transform with %s', (kind) => {
    const registry = new SchemaMigrationRegistry(base,[{fromVersion:1,toVersion:2,description:'transform',operations:[
      {kind:'transform_column',table:'items',column:'source',fnName:'convert',
        ...(kind === 'changed type' && {targetType:'TEXT' as const}),
        transform:v=>kind === 'changed type' ? String(Number(v)*60) : Number(v)*60},
    ]}]);
    const store = new CrdtTableStore(registry,1);
    store.applyOperation(op(1,'source',4,10));
    store.applyOperation(op(2,'source',kind === 'changed type' ? '300' : 300,20));
    expect(store.getRow('a')?.source).toBe(4);
    expect(store.getRawRowState('a')?.unmappedFields.source?.value).toBe(kind === 'changed type' ? '300' : 300);
    store.migrateStoreToVersion(2,[]);
    expect(store.getRow('a')?.source).toBe(kind === 'changed type' ? '300' : 300);
  });

  it('preserves a future-form value until its schema step and never transforms it twice', () => {
    const registry = new SchemaMigrationRegistry(base,migrations);
    const store = new CrdtTableStore(registry,1);
    store.applyOperation(op(1,'source',4,10));
    store.applyOperation(op(3,'estimate','300',20));
    expect(store.getRawRowState('a')?.unmappedFields.estimate?.sourceVersion).toBe(3);
    store.migrateStoreToVersion(2,[]);
    expect(store.getRow('a')?.estimate).toBe(4);
    store.migrateStoreToVersion(3,[]);
    expect(store.getRow('a')?.estimate).toBe('300');
    expect(store.getRawRowState('a')?.unmappedFields.estimate).toBeUndefined();
  });

  it('keeps unknown future fields opaque until migrations are registered', () => {
    const registry = new SchemaMigrationRegistry(base);
    const store = new CrdtTableStore(registry,1);
    store.applyOperation(op(3,'estimate','300',20));
    expect(store.getRawRowState('a')?.unmappedFields.estimate?.schemaPosition).toBe('end');
    for (const step of migrations) registry.registerStep(step);
    store.migrateStoreToVersion(3,[]);
    expect(store.getRow('a')?.estimate).toBe('300');
  });

  it('keeps two unknown future representations of one field until each version is known', () => {
    const registry = new SchemaMigrationRegistry(base);
    const store = new CrdtTableStore(registry,1);
    store.applyOperation(op(3,'estimate','300',30));
    store.applyOperation(op(2,'estimate',4,20));
    expect(store.getRawRowState('a')?.unmappedFields.estimate?.alternatives).toHaveLength(1);
    for (const step of migrations) registry.registerStep(step);
    store.migrateStoreToVersion(2,[]);
    expect(store.getRow('a')?.estimate).toBe(4);
    expect(store.getRawRowState('a')?.unmappedFields.estimate?.value).toBe('300');
    store.migrateStoreToVersion(3,[]);
    expect(store.getRow('a')?.estimate).toBe('300');
  });

  it('does not transform a future value when add and transform occur in the same step', () => {
    const registry = new SchemaMigrationRegistry(base,[{fromVersion:1,toVersion:2,description:'add and transform',operations:[
      {kind:'add_column',table:'items',column:{name:'score',type:'INTEGER',nullable:false,defaultValue:0}},
      {kind:'transform_column',table:'items',column:'score',fnName:'double',transform:v=>Number(v)*2},
    ]}]);
    const store = new CrdtTableStore(registry,1);
    store.applyOperation(op(2,'score',10,20));
    store.migrateStoreToVersion(2,[]);
    expect(store.getRow('a')?.score).toBe(10);
  });

  it('preserves unrelated reused names as separate lineages and restores only the matching future one', () => {
    const schema: TableSchema = {...base,columns:[...base.columns,{name:'value',type:'INTEGER',nullable:false,defaultValue:0}]};
    const registry = new SchemaMigrationRegistry(schema,[
      {fromVersion:1,toVersion:2,description:'drop',operations:[{kind:'drop_column_to_vault',table:'items',column:'value'}]},
      {fromVersion:2,toVersion:3,description:'re-add',operations:[{kind:'add_column',table:'items',column:{name:'value',type:'TEXT',nullable:false,defaultValue:''}}]},
    ]);
    const store = new CrdtTableStore(registry,1);
    store.applyOperation(op(1,'value',12,10));
    store.applyOperation(op(3,'value','new field',20));
    store.migrateStoreToVersion(2,[]);
    expect(store.getRawRowState('a')?.unmappedFields.value?.alternatives).toHaveLength(1);
    store.migrateStoreToVersion(3,[]);
    expect(store.getRow('a')?.value).toBe('new field');
    expect(store.getRawRowState('a')?.unmappedFields.value?.value).toBe(12);
  });

  it('records same-step transformed provenance and restores a specifically requested old lineage', () => {
    const schema: TableSchema = {...base,columns:[...base.columns,{name:'value',type:'INTEGER',nullable:false,defaultValue:0}]};
    const registry = new SchemaMigrationRegistry(schema,[
      {fromVersion:1,toVersion:2,description:'transform/drop',operations:[
        {kind:'transform_column',table:'items',column:'value',fnName:'double',transform:v=>Number(v)*2},
        {kind:'drop_column_to_vault',table:'items',column:'value'},
      ]},
      {fromVersion:2,toVersion:3,description:'restore',operations:[{kind:'add_column',table:'items',column:{name:'value',type:'INTEGER',nullable:false,defaultValue:0},restoreFrom:{column:'value',version:1}}]},
    ]);
    const store = new CrdtTableStore(registry,1);
    store.applyOperation(op(1,'value',3,10));
    store.migrateStoreToVersion(2,[]);
    expect(store.getRawRowState('a')?.unmappedFields.value).toMatchObject({value:6,sourceVersion:2,schemaPosition:1});
    store.migrateStoreToVersion(3,[]);
    expect(store.getRow('a')?.value).toBe(6);
  });

  it('rejects restoring a lineage that remains active under another name', () => {
    expect(() => new SchemaMigrationRegistry(base,[{fromVersion:1,toVersion:2,description:'invalid duplicate',operations:[
      {kind:'add_column',table:'items',column:{name:'duplicate',type:'INTEGER',nullable:false,defaultValue:0},restoreFrom:{column:'source',version:1}},
    ]}])).toThrow(/ACTIVE_RESTORED_LINEAGE/);
  });

  it('rejects primary-key cells that do not match the operation key', () => {
    const store = new CrdtTableStore(new SchemaMigrationRegistry(base),1);
    const bad = op(1,'source',4,10);
    bad.columns.id = {value:'other',hlc:time(10)};
    expect(() => store.applyOperation(bad)).toThrow(/PRIMARY_KEY_MISMATCH/);
    expect(store.getRawRowState('a')).toBeNull();
  });

  it('validates tie values in unknown future fields and vault alternatives', () => {
    const store = new CrdtTableStore(new SchemaMigrationRegistry(base));
    const invalid = op(3,'unknown',4,10);
    invalid.columns.unknown = {value:4,hlc:time(10),tieValue:{} as never};
    expect(() => store.applyOperation(invalid)).toThrow(/UNSUPPORTED_SCALAR_TYPE/);
    const withAlternative: CrdtChangeOperation = {...op(1,'source',1,10),unmappedFields:{x:{
      value:1,hlc:time(10),sourceVersion:1,alternatives:[{value:2,hlc:time(10),sourceVersion:2,tieValue:{} as never}],
    }}};
    expect(() => store.applyOperation(withAlternative)).toThrow();
  });

  it.each([[5,10,10],[15,10,15]] as const)('compares future vault HLC %i against backfill HLC %i', (futureTime,localTime,expected) => {
    const registry = new SchemaMigrationRegistry(base,[migrations[0]!]);
    const store = new CrdtTableStore(registry,1);
    store.applyOperation(op(1,'source',localTime,localTime));
    store.applyOperation(op(2,'estimate',futureTime,futureTime));
    store.migrateStoreToVersion(2,[]);
    expect(store.getRow('a')?.estimate).toBe(expected);
  });

  it('preserves legacy ambiguous entries until explicitly mapped', () => {
    const schema: TableSchema = {...base,columns:[...base.columns,{name:'value',type:'INTEGER',nullable:false,defaultValue:0}]};
    const registry = new SchemaMigrationRegistry(schema,[{fromVersion:1,toVersion:2,description:'unchanged',operations:[]}]);
    const row: CrdtRowState = {table:'items',pk:'a',schemaVersion:1,tombstoneHlc:null,
      cells:{id:{value:'a',hlc:time(1)},source:{value:0,hlc:time(1)},value:{value:1,hlc:time(1)}},
      unmappedFields:{value:{value:7,hlc:time(7),sourceVersion:1}}};
    const migrated = registry.upcastRowState(row,2).row;
    expect(migrated.cells.value?.value).toBe(1);
    expect(migrated.unmappedFields.value?.value).toBe(7);
    const mapped = registry.mapLegacyVaultEntry(migrated,'value',0,1,'end');
    expect(mapped.cells.value?.value).toBe(7);
    expect(mapped.unmappedFields.value).toBeUndefined();
  });

  it('exposes explicit legacy mapping on the engine and keeps it local', async () => {
    const schema: TableSchema = {...base,columns:[...base.columns,{name:'value',type:'INTEGER',nullable:false,defaultValue:0}]};
    const registry = new SchemaMigrationRegistry(schema);
    const engine = new LocalFirstSyncEngine({nodeId:'local',registry});
    engine.upsert('a',{value:1},1);
    const storage = new InMemoryByoStorageAdapter();
    const operation: CrdtChangeOperation = {...op(1,'source',0,7),unmappedFields:{value:{value:7,hlc:time(7),sourceVersion:1}}};
    const passphrase = 'a sufficiently long passphrase';
    await storage.putEnvelope(await encryptSyncOperations({envelopeId:'legacy',nodeId:'node',table:'items',schemaVersion:1,operations:[operation],passphrase,kdfIterations:MIN_KDF_ITERATIONS}));
    await engine.pullFromStorage(storage,passphrase,7);
    const pending = engine.getPendingOutboxCount();
    engine.mapLegacyVaultEntry('a','value',0,1,'end');
    expect(engine.getRow('a')?.value).toBe(7);
    expect(engine.getPendingOutboxCount()).toBe(pending);
  });

  it('merges independent vault incarnations deterministically and considers all for tombstones', () => {
    const row = (entry: CrdtRowState['unmappedFields']['x']): CrdtRowState => ({table:'items',pk:'a',schemaVersion:1,tombstoneHlc:time(10),cells:{},unmappedFields:{x:entry}});
    const a=row({value:1,hlc:time(5),sourceVersion:1,schemaPosition:'end',lineageId:'first'});
    const b=row({value:'new',hlc:time(20),sourceVersion:2,schemaPosition:'end',lineageId:'second'});
    expect(mergeCrdtRowStates(a,b)).toEqual(mergeCrdtRowStates(b,a));
    expect(isRowTombstoned(mergeCrdtRowStates(a,b))).toBe(false);
  });

  it('canonicalizes equal HLC spellings for cells, vault entries, and tombstones in both orders', () => {
    const lower = time(5).replace(':0000:', ':000a:');
    const upper = time(5).replace(':0000:', ':000A:');
    const row = (hlc: string): CrdtRowState => ({table:'items',pk:'a',schemaVersion:1,tombstoneHlc:hlc,
      cells:{id:{value:'a',hlc},source:{value:4,hlc}},
      unmappedFields:{future:{value:'x',hlc,sourceVersion:2,schemaPosition:'end'}}});
    const merged = mergeCrdtRowStates(row(lower),row(upper));
    expect(merged).toEqual(mergeCrdtRowStates(row(upper),row(lower)));
    expect(merged.cells.source?.hlc).toBe(upper);
    expect(merged.unmappedFields.future?.hlc).toBe(upper);
    expect(merged.tombstoneHlc).toBe(upper);
    const store = new CrdtTableStore(new SchemaMigrationRegistry(base));
    const incoming = op(1,'source',4,5);
    incoming.columns.source = {value:4,hlc:lower};
    store.applyOperation({...incoming,hlc:lower});
    expect(store.getRawRowState('a')?.cells.source?.hlc).toBe(upper);
  });
});
