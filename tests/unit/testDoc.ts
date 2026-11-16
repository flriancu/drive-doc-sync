import { UnsupportedDocumentError } from '../../src/errors';
import type { DocumentModel } from '../../src/model';

/** A minimal document for the package's tests: records merged by time, as an app's would be. */
export interface Rec {
  id: string;
  value: string;
  updatedAt: string;
  deleted?: true;
}

export interface TestDoc {
  owner: string;
  records: Record<string, Rec>;
  replaces?: string[];
  /** Set by `read` when the file had the old format; never written back. */
  converted?: number;
}

let tick = 0;
/** Strictly increasing timestamps, independent of (fake) timers. */
const stamp = () => new Date(Date.UTC(2026, 0, 1) + ++tick).toISOString();

export const live = (doc: TestDoc) => Object.values(doc.records).filter((r) => !r.deleted);
export const values = (doc: TestDoc) =>
  live(doc)
    .map((r) => r.value)
    .sort();

export function newDoc(owner: string): TestDoc {
  return { owner, records: {} };
}

export function addRecord(doc: TestDoc, value: string): TestDoc {
  const id = `r${++tick}`;
  return { ...doc, records: { ...doc.records, [id]: { id, value, updatedAt: stamp() } } };
}

function merge(local: TestDoc, remote: TestDoc): TestDoc {
  const records = { ...remote.records };
  for (const [id, mine] of Object.entries(local.records)) {
    const theirs = Object.hasOwn(remote.records, id) ? remote.records[id] : undefined;
    if (!theirs || mine.updatedAt > theirs.updatedAt) records[id] = mine;
  }
  return { ...remote, records };
}

function hasLocalWins(local: TestDoc, remote: TestDoc): boolean {
  return Object.entries(local.records).some(([id, mine]) => {
    const theirs = Object.hasOwn(remote.records, id) ? remote.records[id] : undefined;
    return !theirs || mine.updatedAt > theirs.updatedAt;
  });
}

function read(raw: unknown): TestDoc {
  const v = raw as Partial<TestDoc> & { legacy?: unknown };
  if (typeof v !== 'object' || v === null || typeof v.owner !== 'string' || typeof v.records !== 'object' || v.records === null) {
    throw new UnsupportedDocumentError('Not a test document', 'notDoc');
  }
  const doc: TestDoc = { owner: v.owner, records: v.records, ...(Array.isArray(v.replaces) && { replaces: v.replaces }) };
  return v.legacy === true ? { ...doc, converted: 1 } : doc;
}

function write(doc: TestDoc): unknown {
  const { converted: _converted, ...rest } = doc;
  return rest;
}

export const testModel: DocumentModel<TestDoc, 'converted'> = {
  read,
  write,
  merge,
  hasLocalWins,
  absorb: (into, from) => merge(from, into),
  owner: (doc) => doc.owner,
  replaces: (doc) => doc.replaces ?? [],
  withReplaces: (doc, fileIds) => ({ ...doc, replaces: [...fileIds] }),
  contentCount: (doc) => live(doc).length,
  size: (doc) => live(doc).length,
  needsResave: (opened) => (opened.converted ?? 0) > 0,
  openNotices: (opened) => (opened.converted ? [{ kind: 'converted', count: opened.converted }] : []),
};
