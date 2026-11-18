import type { DocumentModel } from '../model';

/**
 * A copy of the document kept on this device, written synchronously on every change. Saving to
 * Drive takes two requests and a debounce; a reload, a closed tab, a crash or an expired
 * session can cut that short. The copy survives all of them, and the next open merges it back
 * (records are merged by time, so replaying it is always safe).
 */
export interface ReplicaStore<Doc> {
  /** The copy, the storage file (Drive file) it was a copy of, and that file's version it holds. */
  read(): ReplicaCopy<Doc> | null;
  /**
   * `unsaved`: holds changes that may not be in Drive yet. `version`: a version of `fileId`
   * whose every record `doc` holds, so a file still at that version needs no download.
   * Returns false when the copy could not be stored (storage full or blocked).
   */
  write(doc: Doc, unsaved: boolean, fileId?: string, version?: string): boolean;
  hasUnsaved(): boolean;
  clear(): void;
}

export interface ReplicaCopy<Doc> {
  doc: Doc;
  fileId?: string;
  version?: string;
  unsaved: boolean;
}

/** Whose copy it is, so a signed-out page can say which account has changes waiting. */
export interface ReplicaAccount {
  sub: string;
  email: string;
  name: string;
}

interface Stored {
  unsaved: boolean;
  doc: unknown;
  account?: ReplicaAccount;
  /** Older copies call it `calendarId`; both are read. */
  fileId?: string;
  calendarId?: string;
  version?: string;
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The localStorage key prefix of an app's copies, e.g. `vacation-planner.replica.`. */
const prefixOf = (app: string) => `${app}.replica.`;

/** The copy in localStorage, one per Google account, shared by the tabs of this browser. */
export class LocalReplica<Doc> implements ReplicaStore<Doc> {
  constructor(
    private readonly key: string,
    private readonly model: Pick<DocumentModel<Doc>, 'read' | 'write' | 'merge' | 'hasLocalWins'>,
    private readonly account?: ReplicaAccount,
    private readonly store: KeyValueStore | null = safeLocalStorage(),
  ) {}

  read(): ReplicaCopy<Doc> | null {
    return this.stored();
  }

  write(doc: Doc, unsaved: boolean, fileId?: string, version?: string): boolean {
    // Another tab may have written records this one hasn't seen: keep them (merge by time).
    const before = this.stored();
    const merged = before ? this.model.merge(doc, before.doc) : doc;
    // Still unsaved if this change is, or if the copy held something (another tab's) that `doc` lacks.
    const stillUnsaved = unsaved || (!!before?.unsaved && this.model.hasLocalWins(before.doc, doc));
    const file = fileId ?? before?.fileId;
    // The merged copy holds every record of both copies it came from, so the version either one
    // held is still true of it: this tab's, else the stored one for the same file.
    const holds = version ?? (file === before?.fileId ? before?.version : undefined);
    try {
      const stored: Stored = {
        unsaved: stillUnsaved,
        doc: this.model.write(merged),
        ...(this.account && { account: this.account }),
        ...(file && { fileId: file }),
        ...(file && holds && { version: holds }),
      };
      if (!this.store) return false;
      this.store.setItem(this.key, JSON.stringify(stored));
      return true;
    } catch {
      // Storage full (a document over the browser's quota) or blocked: there is no copy, and the
      // caller must not promise one.
      return false;
    }
  }

  hasUnsaved(): boolean {
    return this.stored()?.unsaved ?? false;
  }

  clear() {
    try {
      this.store?.removeItem(this.key);
    } catch {
      // nothing to clear
    }
  }

  private stored(): ReplicaCopy<Doc> | null {
    try {
      const raw = this.store?.getItem(this.key);
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<Stored>;
      const fileId = typeof value.fileId === 'string' ? value.fileId : value.calendarId;
      return {
        unsaved: value.unsaved === true,
        doc: this.model.read(value.doc),
        ...(typeof fileId === 'string' && { fileId }),
        ...(typeof fileId === 'string' && typeof value.version === 'string' && { version: value.version }),
      };
    } catch {
      return null; // unreadable: ignore it rather than break the app
    }
  }
}

/** The replica key for a Google account of an app. */
export const replicaKey = (app: string, sub: string) => `${prefixOf(app)}${sub}`;

/**
 * Every account with changes on this device that haven't reached Drive (a shared computer can
 * hold more than one): signed out, the page offers to sign in as them, so nothing is orphaned.
 */
export function unsavedCopies(app: string, store: globalThis.Storage | null = safeLocalStorage()): ReplicaAccount[] {
  const prefix = prefixOf(app);
  const out: ReplicaAccount[] = [];
  if (!store) return out;
  let keys: string[] = [];
  try {
    keys = Array.from({ length: store.length }, (_, i) => store.key(i)).filter((k): k is string => !!k?.startsWith(prefix));
  } catch {
    return out; // unreadable storage: nothing to offer
  }
  for (const key of keys) {
    try {
      const value = JSON.parse(store.getItem(key) ?? 'null') as Partial<Stored> | null;
      const a = value?.account;
      if (value?.unsaved === true && a && typeof a.email === 'string' && a.email && typeof a.name === 'string') {
        out.push({ sub: key.slice(prefix.length), email: a.email, name: a.name.trim() || a.email.split('@')[0]! });
      }
    } catch {
      // one unreadable copy says nothing about the others
    }
  }
  return out;
}

/** Deletes the copies that hold nothing unsaved (a sign-out from the error screen). */
export function forgetSavedCopies(app: string, store: globalThis.Storage | null = safeLocalStorage()) {
  const prefix = prefixOf(app);
  try {
    const keys = Array.from({ length: store?.length ?? 0 }, (_, i) => store!.key(i)).filter((k): k is string => !!k?.startsWith(prefix));
    for (const key of keys) {
      const value = JSON.parse(store!.getItem(key) ?? 'null') as Partial<Stored> | null;
      if (value?.unsaved !== true) store!.removeItem(key);
    }
  } catch {
    // nothing to forget
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
