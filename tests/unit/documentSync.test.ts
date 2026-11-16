import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../../src/storage/MemoryStorage';
import type { SaveResult } from '../../src/storage/Storage';
import { DocumentMissingError, DocumentRemovedError, DocumentSync, OtherOwnerError, type SyncOptions } from '../../src/sync/DocumentSync';
import { LocalReplica } from '../../src/sync/Replica';
import { addRecord, newDoc, testModel, values, type TestDoc } from './testDoc';

/** MemoryStorage with switches: fail the next saves, or let a save skip the version check (the Drive race). */
class TestStorage extends MemoryStorage<TestDoc> {
  failSaves: unknown[] = [];
  ignoreVersion = false;
  saves = 0;

  override async save(fileId: string, doc: TestDoc, baseVersion: string): Promise<SaveResult> {
    this.saves++;
    const failure = this.failSaves.shift();
    if (failure) throw failure;
    return super.save(fileId, doc, this.ignoreVersion ? await this.version(fileId) : baseVersion);
  }
}

class MapStore {
  readonly items = new Map<string, string>();
  getItem = (k: string) => this.items.get(k) ?? null;
  setItem = (k: string, v: string) => void this.items.set(k, v);
  removeItem = (k: string) => void this.items.delete(k);
}

const OWNER = 'sub-1';
const init = () => newDoc(OWNER);
const replicaIn = (store: MapStore, key = 'r') => new LocalReplica(key, testModel, undefined, store);

function sync(storage: MemoryStorage<TestDoc>, extra: Partial<SyncOptions<TestDoc, 'converted'>> = {}) {
  return new DocumentSync({ storage, model: testModel, init, owner: OWNER, saveDelayMs: 1500, ...extra });
}

const add = (s: DocumentSync<TestDoc, 'converted'>, value: string) => s.update((d) => addRecord(d, value));

async function storedDoc(storage: MemoryStorage<TestDoc>) {
  const [ref] = await storage.listFiles();
  return (await storage.load(ref!.fileId)).doc;
}

const stored = async (storage: MemoryStorage<TestDoc>) => values(await storedDoc(storage));

/** A document file another device created on its own, holding one record. */
const otherDevicesDoc = (value: string) => addRecord(init(), value);

const retryable = Object.assign(new Error('503'), { retryable: true });
const signin = Object.assign(new Error('expired'), { needsSignIn: true });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('DocumentSync', () => {
  it('creates my document on first use and saves edits after the debounce', async () => {
    const storage = new TestStorage();
    const s = sync(storage);
    await s.open();
    add(s, 'a');
    expect(s.getSnapshot().saveState).toBe('saving');
    await vi.advanceTimersByTimeAsync(1500);
    expect(s.getSnapshot().saveState).toBe('saved');
    expect(await stored(storage)).toEqual(['a']);
  });

  it('keeps an edit made right before the page died, and saves it on the next open', async () => {
    const storage = new TestStorage();
    const store = new MapStore();
    const first = sync(storage, { replica: replicaIn(store) });
    await first.open();
    add(first, 'a'); // and the tab is closed 300 ms later: no save ever runs
    expect(await stored(storage)).toEqual([]);

    const next = sync(storage, { replica: replicaIn(store) });
    await next.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(await stored(storage)).toEqual(['a']);
    expect(replicaIn(store).hasUnsaved()).toBe(false);
  });

  it('retries a failed save by itself, with growing delays', async () => {
    const storage = new TestStorage();
    const s = sync(storage);
    await s.open();
    storage.failSaves = [retryable, retryable];
    add(s, 'a');
    await vi.advanceTimersByTimeAsync(1500);
    expect(s.getSnapshot().saveState).toBe('error');
    await vi.advanceTimersByTimeAsync(3000); // first retry after 2-3 s: fails again
    expect(storage.saves).toBe(2);
    await vi.advanceTimersByTimeAsync(5000); // second retry after 4-5 s: works
    expect(s.getSnapshot().saveState).toBe('saved');
    expect(await stored(storage)).toEqual(['a']);
  });

  it('does not retry by itself what retrying cannot fix, but "try again" works', async () => {
    const storage = new TestStorage();
    const s = sync(storage);
    await s.open();
    storage.failSaves = [new Error('403 forbidden')];
    add(s, 'a');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(storage.saves).toBe(1);
    expect(s.getSnapshot().saveState).toBe('error');
    await s.flush();
    expect(s.getSnapshot().saveState).toBe('saved');
  });

  it('asks to sign in again on an expired session, and keeps that state while editing', async () => {
    const storage = new TestStorage();
    const s = sync(storage);
    await s.open();
    storage.failSaves = [signin, signin];
    add(s, 'a');
    await vi.advanceTimersByTimeAsync(1500);
    expect(s.getSnapshot().saveState).toBe('signin');
    add(s, 'b');
    expect(s.getSnapshot().saveState).toBe('signin');
  });

  it('repairs an edit lost to two devices writing at the same moment', async () => {
    const storage = new TestStorage();
    const phone = sync(storage, { replica: replicaIn(new MapStore(), 'phone') });
    const laptop = sync(storage);
    await phone.open();
    await laptop.open();
    add(phone, 'from phone');
    await phone.flush();
    // The laptop checked the version just before the phone wrote, then wrote over it.
    storage.ignoreVersion = true;
    add(laptop, 'from laptop');
    await laptop.flush();
    storage.ignoreVersion = false;
    expect(await stored(storage)).toEqual(['from laptop']);
    // The phone comes back into view: it sees a new version, merges, and saves its record back.
    await phone.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(await stored(storage)).toEqual(['from laptop', 'from phone']);
  });

  it('picks up what another device saved when the page comes back into view', async () => {
    const storage = new TestStorage();
    const a = sync(storage);
    const b = sync(storage);
    await a.open();
    await b.open();
    add(a, 'a');
    await a.flush();
    await b.refresh();
    expect(values(b.getSnapshot().doc!)).toEqual(['a']);
    expect(b.dirty).toBe(false);
  });

  it('merges duplicate files into the oldest and removes the others', async () => {
    const storage = new TestStorage();
    const a = sync(storage);
    await a.open();
    add(a, 'a');
    await a.flush();
    await storage.create(otherDevicesDoc('b'));

    const s = sync(storage);
    await s.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(await storage.listFiles()).toHaveLength(1);
    expect(await stored(storage)).toEqual(['a', 'b']);
  });

  it('opens the document even when a duplicate file cannot be read, and leaves that file alone', async () => {
    const storage = new (class extends TestStorage {
      override async load(id: string) {
        if (id === 'memory-2') throw new Error('not JSON');
        return super.load(id);
      }
    })();
    await storage.create(otherDevicesDoc('a'));
    await storage.create(otherDevicesDoc('b'));
    const s = sync(storage);
    await s.open();
    expect(s.getSnapshot().loadError).toBeNull();
    expect(values(s.getSnapshot().doc!)).toEqual(['a']);
    expect(await storage.listFiles()).toHaveLength(2);
  });

  it('does not start an empty document over one in the trash, unless asked', async () => {
    const storage = new TestStorage();
    const { fileId } = await storage.create(init());
    await storage.remove(fileId);
    const s = sync(storage);
    await s.open();
    expect(s.getSnapshot().loadError).toBeInstanceOf(DocumentRemovedError);
    await s.open('new');
    expect(s.getSnapshot().loadError).toBeNull();
    expect(await storage.listFiles()).toHaveLength(1);
  });

  it('refuses a document file that belongs to another account', async () => {
    const storage = new TestStorage();
    await storage.create(newDoc('someone-else'));
    const s = sync(storage);
    await s.open();
    expect(s.getSnapshot().loadError).toBeInstanceOf(OtherOwnerError);
  });

  it('carries the demo document into mine once, and says so', async () => {
    const storage = new TestStorage();
    const demo = new MemoryStorage<TestDoc>();
    const d = new DocumentSync({ storage: demo, model: testModel, init });
    await d.open();
    add(d as DocumentSync<TestDoc, 'converted'>, 'beach');
    await d.close();
    const s = sync(storage, { carry: () => demo.latest() });
    await s.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(await stored(storage)).toEqual(['beach']);
    expect(s.getSnapshot().notices).toEqual([{ kind: 'carried', count: 1 }]);
  });

  it('saves what is left when closed (sign-out), and says whether everything got saved', async () => {
    const storage = new TestStorage();
    const s = sync(storage);
    await s.open();
    add(s, 'a');
    expect(await s.close()).toBe(true);
    expect(await stored(storage)).toEqual(['a']);

    const t = sync(storage);
    await t.open();
    storage.failSaves = [retryable];
    add(t, 'b');
    expect(await t.close()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(storage.saves).toBe(2); // closed: no retries behind the user's back
  });

  it('starts a really new document: the old one on this device stays out of it', async () => {
    const storage = new TestStorage();
    const store = new MapStore();
    const old = sync(storage, { replica: replicaIn(store) });
    await old.open();
    add(old, 'old private note');
    await old.flush();
    await storage.remove((await storage.listFiles())[0]!.fileId);

    const s = sync(storage, { replica: replicaIn(store) });
    await s.open();
    expect(s.getSnapshot().loadError).toBeInstanceOf(DocumentRemovedError);
    await s.open('new');
    await vi.advanceTimersByTimeAsync(0);
    expect(values(s.getSnapshot().doc!)).toEqual([]);
    expect(JSON.stringify(await storedDoc(storage))).not.toContain('old private note');
    expect(store.items.size).toBe(1); // a fresh copy of the new document only
    expect(store.items.values().next().value).not.toContain('old private note');
  });

  it('when its file goes away (merged into an older one), finds the document again and adds its changes', async () => {
    const storage = new TestStorage();
    const b = sync(storage, { replica: replicaIn(new MapStore(), 'b') });
    await b.open();
    const bFile = (await storage.listFiles())[0]!.fileId;
    // Meanwhile another device's file is the one that counts, and B's file goes to the trash.
    await storage.create(otherDevicesDoc('other'));
    await storage.remove(bFile);
    storage.failSaves = [Object.assign(new Error('trashed'), { fileGone: true })];
    add(b, 'mine');
    await vi.advanceTimersByTimeAsync(1500); // the save meets the trashed file; the document is looked up again
    await vi.advanceTimersByTimeAsync(100); // and the merged document is saved
    expect(b.getSnapshot().loadError).toBeNull();
    expect(await stored(storage)).toEqual(['mine', 'other']);
  });

  it('signs out after at most a few seconds when Drive does not answer', async () => {
    const storage = new (class extends TestStorage {
      hang = false;
      override save(fileId: string, doc: TestDoc, base: string) {
        return this.hang ? new Promise<SaveResult>(() => {}) : super.save(fileId, doc, base);
      }
    })();
    const s = sync(storage, { closeWaitMs: 5000 });
    await s.open();
    storage.hang = true;
    add(s, 'a');
    let done: boolean | undefined;
    void s.close().then((clean) => (done = clean));
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(false); // not saved: the device's copy keeps it
  });

  it('tries opening again by itself after a passing failure', async () => {
    const storage = new (class extends TestStorage {
      failLists = 1;
      override async listFiles() {
        if (this.failLists-- > 0) throw Object.assign(new Error('503'), { retryable: true });
        return super.listFiles();
      }
    })();
    const s = sync(storage);
    await s.open();
    expect(s.getSnapshot().loadError).not.toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.getSnapshot().loadError).toBeNull();
    expect(s.getSnapshot().doc).not.toBeNull();
  });

  it("saves a document converted on reading once, and reports the app's notices", async () => {
    const storage = new TestStorage();
    const file = { ...otherDevicesDoc('a'), legacy: true };
    const { fileId } = await storage.create(file as TestDoc);
    // What Drive would hand out goes through `read`, which converts the old format.
    const reading = new (class extends TestStorage {
      override load = async (id: string) => ({ doc: testModel.read((await storage.load(id)).doc), version: await storage.version(id) });
      override listFiles = () => storage.listFiles();
      override save = (id: string, doc: TestDoc, base: string) => storage.save(id, doc, base);
      override version = (id: string) => storage.version(id);
    })();
    const s = sync(reading);
    await s.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getSnapshot().notices).toEqual([{ kind: 'converted', count: 1 }]);
    expect(storage.saves).toBe(1);
    expect((await storage.load(fileId)).doc).not.toHaveProperty('legacy');
  });
});

describe('DocumentSync: after sign-out, deleted documents, replaced documents', () => {
  it('never looks for its document again once closed (a later sign-in is someone else)', async () => {
    const storage = new (class extends TestStorage {
      lists = 0;
      override async listFiles() {
        this.lists++;
        return super.listFiles();
      }
    })();
    const s = sync(storage);
    await s.open();
    storage.failSaves = [Object.assign(new Error('gone'), { fileGone: true })];
    add(s, 'a');
    const lists = storage.lists;
    await s.close(); // the last save meets a gone file after the sign-out
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.lists).toBe(lists);
  });

  it('ignores a change that arrives after sign-out: the device copy stays cleared', async () => {
    const storage = new TestStorage();
    const store = new MapStore();
    const replica = replicaIn(store);
    const s = sync(storage, { replica });
    await s.open();
    await s.close();
    replica.clear(); // what signing out does
    add(s, 'a'); // say, Google's picker answering late
    expect(store.items.size).toBe(0);
    expect(replica.read()).toBeNull();
  });

  it('asks before bringing a document deleted for good back from a device copy', async () => {
    const storage = new TestStorage();
    const store = new MapStore();
    const first = sync(storage, { replica: replicaIn(store) });
    await first.open();
    add(first, 'private');
    await first.flush();
    // Deleted for good in Drive: not listed, not in the trash.
    (storage as unknown as { files: Map<string, unknown> }).files.clear();

    const s = sync(storage, { replica: replicaIn(store) });
    await s.open();
    expect(s.getSnapshot().loadError).toBeInstanceOf(DocumentMissingError);
    expect(await storage.listFiles()).toEqual([]);
    await s.open('restore');
    await vi.advanceTimersByTimeAsync(0);
    expect(await stored(storage)).toEqual(['private']);
  });

  it('keeps copies of a replaced document out of the new one, on every device', async () => {
    const storage = new TestStorage();
    const laptop = new MapStore();
    const a = sync(storage, { replica: replicaIn(laptop) });
    await a.open();
    add(a, 'old document');
    await a.flush();
    await storage.remove((await storage.listFiles())[0]!.fileId);

    const phone = sync(storage, { replica: replicaIn(new MapStore()) });
    await phone.open();
    await phone.open('new');
    await vi.advanceTimersByTimeAsync(0);
    // The laptop opens the app again: its copy of the old document must not come back.
    const again = sync(storage, { replica: replicaIn(laptop) });
    await again.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(await stored(storage)).toEqual([]);
    expect(laptop.items.values().next().value).not.toContain('old document');
  });
});
