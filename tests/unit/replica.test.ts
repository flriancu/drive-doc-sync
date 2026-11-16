import { describe, expect, it } from 'vitest';
import { forgetSavedCopies, LocalReplica, replicaKey, unsavedCopies } from '../../src/sync/Replica';
import { addRecord, newDoc, testModel, values } from './testDoc';

/** A localStorage stand-in with the parts the copies use. */
class FakeStorage {
  private readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key = (i: number) => [...this.items.keys()][i] ?? null;
  getItem = (k: string) => this.items.get(k) ?? null;
  setItem = (k: string, v: string) => void this.items.set(k, v);
  removeItem = (k: string) => void this.items.delete(k);
  clear = () => this.items.clear();
}

const APP = 'test-app';
const doc = () => addRecord(newDoc('sub-1'), 'a');
const replica = (sub: string, account: { sub: string; email: string; name: string } | undefined, store: Storage) =>
  new LocalReplica(replicaKey(APP, sub), testModel, account, store);

describe("this device's copies of documents", () => {
  it('says which accounts have changes waiting, so none is forgotten on a shared computer', () => {
    const store = new FakeStorage() as unknown as Storage;
    replica('alice', { sub: 'alice', email: 'alice@example.test', name: 'Alice' }, store).write(doc(), true);
    replica('bob', { sub: 'bob', email: 'bob@example.test', name: 'Bob' }, store).write(doc(), false);
    expect(unsavedCopies(APP, store)).toEqual([{ sub: 'alice', email: 'alice@example.test', name: 'Alice' }]);
  });

  it("only looks at this app's copies", () => {
    const store = new FakeStorage() as unknown as Storage;
    new LocalReplica(replicaKey('other-app', 'alice'), testModel, { sub: 'alice', email: 'a@x', name: 'A' }, store).write(doc(), true);
    expect(unsavedCopies(APP, store)).toEqual([]);
    forgetSavedCopies(APP, store);
    expect(store.length).toBe(1);
  });

  it('forgets copies with nothing unsaved, and keeps the others', () => {
    const store = new FakeStorage() as unknown as Storage;
    replica('alice', { sub: 'alice', email: 'a@x', name: 'A' }, store).write(doc(), true);
    replica('bob', { sub: 'bob', email: 'b@x', name: 'B' }, store).write(doc(), false);
    forgetSavedCopies(APP, store);
    expect(store.getItem(replicaKey(APP, 'alice'))).not.toBeNull();
    expect(store.getItem(replicaKey(APP, 'bob'))).toBeNull();
  });

  it('is not blinded by one unreadable copy, and names an account without a name by its address', () => {
    const store = new FakeStorage() as unknown as Storage;
    store.setItem(replicaKey(APP, 'broken'), '{not json');
    replica('maria', { sub: 'maria', email: 'maria@example.test', name: ' ' }, store).write(doc(), true);
    store.setItem(replicaKey(APP, 'zz-broken'), '{"unsaved":true,"account":{"email":"","name":""}}');
    expect(unsavedCopies(APP, store)).toEqual([{ sub: 'maria', email: 'maria@example.test', name: 'maria' }]);
  });

  it('keeps records another tab wrote, and reads the file id of copies written by older versions', () => {
    const store = new FakeStorage() as unknown as Storage;
    const tabA = replica('s', undefined, store);
    tabA.write(addRecord(newDoc('sub-1'), 'from tab A'), true, 'file-1');
    replica('s', undefined, store).write(addRecord(newDoc('sub-1'), 'from tab B'), true);
    const read = tabA.read()!;
    expect(values(read.doc)).toEqual(['from tab A', 'from tab B']);
    expect(read.fileId).toBe('file-1');

    store.setItem(replicaKey(APP, 'old'), JSON.stringify({ unsaved: false, doc: doc(), calendarId: 'file-old' }));
    expect(replica('old', undefined, store).read()!.fileId).toBe('file-old');
  });
});
