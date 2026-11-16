import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../../src/storage/MemoryStorage';
import { FollowedDocuments } from '../../src/sync/Followed';
import { addRecord, newDoc, testModel, values, type TestDoc } from './testDoc';

const MAX = 100;
const someone = (value: string) => addRecord(newDoc('ana'), value);
const follow = (storage: MemoryStorage<TestDoc>, now?: () => number) => new FollowedDocuments(storage, testModel, MAX, now);

describe('FollowedDocuments', () => {
  it('loads every followed document read-only, each on its own', async () => {
    const storage = new MemoryStorage<TestDoc>();
    const a = await storage.create(someone('august'));
    const f = follow(storage);
    await f.set([a.fileId, 'gone']);
    const [ana, gone] = f.getSnapshot();
    expect(values(ana!.doc!)).toEqual(['august']);
    expect(gone!.doc).toBeUndefined();
    expect(gone!.state).toBe('gone'); // the other one still loaded
  });

  it('picks up changes when refreshed, and says so when the document is gone', async () => {
    const storage = new MemoryStorage<TestDoc>();
    const a = await storage.create(someone('august'));
    const f = follow(storage);
    await f.set([a.fileId]);
    const { version } = await storage.load(a.fileId);
    await storage.save(a.fileId, someone('september'), version);
    await f.refresh();
    expect(values(f.getSnapshot()[0]!.doc!)).toEqual(['september']);
    await storage.remove(a.fileId); // sharing stopped
    await f.refresh();
    expect(f.getSnapshot()[0]!.state).toBe('gone');
    expect(f.getSnapshot()[0]!.doc).toBeUndefined();
  });

  it('keeps what it loaded through a passing failure, says it is stale, and tries again', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage<TestDoc>();
      const a = await storage.create(someone('august'));
      const f = follow(storage, () => 1000);
      await f.set([a.fileId]);
      const { version } = await storage.load(a.fileId);
      await storage.save(a.fileId, someone('september'), version);
      const load = storage.load.bind(storage);
      let offline = true;
      storage.load = (id) => (offline ? Promise.reject(Object.assign(new Error('offline'), { retryable: true })) : load(id));
      await f.refresh();
      expect(f.getSnapshot()[0]).toMatchObject({ state: 'stale', loadedAt: 1000 });
      expect(values(f.getSnapshot()[0]!.doc!)).toEqual(['august']);
      offline = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.getSnapshot()[0]!.state).toBe('ready');
      expect(values(f.getSnapshot()[0]!.doc!)).toEqual(['september']);
      f.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a document too big to show', async () => {
    const storage = new MemoryStorage<TestDoc>();
    let big = newDoc('ana');
    for (let i = 0; i <= MAX; i++) big = addRecord(big, `r${i}`);
    const a = await storage.create(big);
    const f = follow(storage);
    await f.set([a.fileId]);
    expect(f.getSnapshot()[0]!.state).toBe('tooBig');
    expect(f.getSnapshot()[0]!.doc).toBeUndefined();
  });

  it('drops a document that is no longer followed', async () => {
    const storage = new MemoryStorage<TestDoc>();
    const a = await storage.create(someone('august'));
    const f = follow(storage);
    await f.set([a.fileId]);
    await f.set([]);
    expect(f.getSnapshot()).toEqual([]);
  });

  it('answers a burst of refreshes with one round of requests', async () => {
    const storage = new MemoryStorage<TestDoc>();
    const a = await storage.create(someone('august'));
    const f = follow(storage);
    await f.set([a.fileId]);
    let checks = 0;
    const version = storage.version.bind(storage);
    storage.version = (id) => (checks++, version(id));
    await Promise.all(Array.from({ length: 100 }, () => f.refresh()));
    expect(checks).toBe(1);
  });
});
