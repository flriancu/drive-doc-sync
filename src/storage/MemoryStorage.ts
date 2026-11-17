import type { FileRef, SaveResult, Storage } from './Storage';

/** In-memory storage for a signed-out demo and for tests. Nothing survives a reload. */
export class MemoryStorage<Doc> implements Storage<Doc> {
  readonly kind = 'memory';
  private readonly files = new Map<string, { doc: Doc; version: number; removed?: true }>();
  private nextId = 1;

  constructor(seed: Doc[] = []) {
    for (const doc of seed) this.files.set(`memory-${this.nextId++}`, { doc: structuredClone(doc), version: 1 });
  }

  async listFiles(): Promise<FileRef[]> {
    return this.refs(false);
  }

  async listRemoved(): Promise<FileRef[]> {
    return this.refs(true);
  }

  async load(fileId: string) {
    const file = this.get(fileId);
    return { doc: structuredClone(file.doc), version: String(file.version) };
  }

  async version(fileId: string) {
    return String(this.get(fileId).version);
  }

  async save(fileId: string, doc: Doc, baseVersion: string): Promise<SaveResult> {
    const file = this.get(fileId);
    if (String(file.version) !== baseVersion) return { ok: false, conflict: true };
    file.doc = structuredClone(doc);
    file.version++;
    return { ok: true, version: String(file.version) };
  }

  async create(initial: Doc) {
    const fileId = `memory-${this.nextId++}`;
    this.files.set(fileId, { doc: structuredClone(initial), version: 1 });
    return { fileId, version: '1' };
  }

  async remove(fileId: string) {
    this.get(fileId).removed = true;
  }

  /** The newest saved state of my document, or null (for carrying a demo into an account). */
  latest(): Doc | null {
    const file = [...this.files.values()].find((f) => !f.removed);
    return file ? structuredClone(file.doc) : null;
  }

  private refs(removed: boolean): FileRef[] {
    return [...this.files]
      .filter(([, f]) => !!f.removed === removed)
      .map(([fileId, f]) => ({ fileId, ownerName: '', writable: true, version: String(f.version) }));
  }

  private get(fileId: string) {
    const file = this.files.get(fileId);
    if (!file || file.removed) throw new Error(`No file ${fileId}`);
    return file;
  }
}
