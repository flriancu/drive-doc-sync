import type { DocumentModel, SyncNotice } from '../model';
import { UnsupportedDocumentError } from '../errors';
import { fileGone, isRetryable, needsSignIn, type Storage } from '../storage/Storage';
import type { ReplicaCopy, ReplicaStore } from './Replica';
import { retryDelay } from './retry';

/** `signin`: the Google session expired; changes are kept until the user reconnects. */
export type SaveState = 'saved' | 'saving' | 'error' | 'signin';

export interface SyncSnapshot<Doc, Notice extends string = string> {
  doc: Doc | null;
  saveState: SaveState;
  /** Why the last save failed, while `saveState` is `error`. */
  saveError: unknown;
  loadError: unknown;
  notices: readonly SyncNotice<Notice>[];
  /**
   * False when this device could not store its copy (storage full or blocked): changes not in
   * storage yet then live only in this page, and closing it loses them.
   */
  copyKept: boolean;
}

export interface SyncOptions<Doc, Notice extends string = string> {
  storage: Storage<Doc>;
  model: DocumentModel<Doc, Notice>;
  /** A new document, when I have none yet. */
  init: () => Doc;
  /** The signed-in account: a document file of another account is refused. */
  owner?: string;
  replica?: ReplicaStore<Doc>;
  /** A document whose records are added to mine once it is open (the demo, at sign-in). */
  carry?: () => Doc | null;
  /** Debounce before saving. */
  saveDelayMs?: number;
  /** How long `close` waits for a last save before giving up on it (sign-out must not hang). */
  closeWaitMs?: number;
}

/** No document file, but one in the Drive trash: restore it, or start a new one on purpose. */
export class DocumentRemovedError extends Error {
  constructor() {
    super('Your file is in the Google Drive trash');
  }
}

/** No document file anywhere in Drive, but this device has a copy of one: restore it, or start anew. */
export class DocumentMissingError extends Error {
  constructor() {
    super('Your file is no longer in Google Drive; this device has a copy of it');
  }
}

/** How to open: as usual; a new document instead of the one in the trash; or the document from this device's copy. */
export type OpenMode = 'normal' | 'new' | 'restore';

export class OtherOwnerError extends Error {
  constructor() {
    super('This file belongs to another Google account');
  }
}

/** Saving kept meeting newer versions from another device; worth another try later. */
export class SaveConflictError extends Error {
  readonly retryable = true;
  constructor() {
    super('Another device kept saving at the same time');
  }
}

const MAX_ROUNDS = 3;

/**
 * The open document and its way to storage: open (show this device's copy at once, download
 * the file only if it changed since, create, merge duplicates, merge this device's copy, carry
 * the demo in), auto-save with a debounce, merge on conflicts, retry with
 * growing delays, pick up other devices' changes on `refresh`, save what's left on `close`.
 * Every storage call runs in one queue, so they never overlap. No React and no DOM here: the
 * app connects it to the page's events.
 */
export class DocumentSync<Doc extends object, Notice extends string = string> {
  private snapshot: SyncSnapshot<Doc, Notice> = {
    doc: null,
    saveState: 'saved',
    saveError: null,
    loadError: null,
    notices: [],
    copyKept: true,
  };
  private readonly listeners = new Set<() => void>();
  private opening: Promise<void> | null = null;
  private current: Doc | null = null;
  private saved: Doc | null = null;
  private fileId = '';
  /** The file a reopen left: what this tab holds is a copy of it, which a new document may have replaced. */
  private reopenedFrom = '';
  private version = '';
  private duplicates: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private loadAttempts = 0;
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly options: SyncOptions<Doc, Notice>) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  /** My document's id in storage (the Drive file), once open: for sharing it, and to tell it from documents I follow. */
  get file(): string {
    return this.fileId;
  }

  /** True while some change may not be in storage yet. */
  get dirty(): boolean {
    return this.current !== this.saved;
  }

  /** Opens my document; idempotent. See `OpenMode` for the ways out of a missing or trashed document. */
  open(how: OpenMode = 'normal'): Promise<void> {
    this.closed = false;
    clearTimeout(this.loadTimer);
    if (this.opening && how === 'normal') return this.opening;
    this.set({ loadError: null });
    this.opening = this.enqueue(() => this.openOwn(how)).then(
      () => {
        this.loadAttempts = 0;
      },
      (e: unknown) => {
        this.opening = null;
        this.set({ loadError: e });
        // What the message promises: a passing problem is tried again, with growing delays.
        if (isRetryable(e) && !this.closed) this.loadTimer = setTimeout(() => void this.open(), retryDelay(this.loadAttempts++));
      },
    );
    return this.opening;
  }

  update = (change: (doc: Doc) => Doc) => {
    // Closed (signed out): a late answer (Google's picker, a slow dialog) must not write the
    // document back to this device, which signing out has just cleared.
    if (!this.current || this.closed) return;
    this.current = change(this.current);
    this.keepCopy(true);
    this.set({ doc: this.current, saveState: this.snapshot.saveState === 'signin' ? 'signin' : 'saving' });
    this.schedule(this.options.saveDelayMs ?? 1500);
  };

  /** Saves now (and waits). Never rejects: failures become `saveState`. */
  flush = (): Promise<void> => {
    clearTimeout(this.timer);
    return this.enqueue(() => this.saveRounds()).then(
      () => {
        this.attempts = 0;
      },
      (e: unknown) => this.failed(e),
    );
  };

  /** Picks up what other devices saved meanwhile (a tab coming back into view). */
  refresh = (): Promise<void> =>
    this.enqueue(async () => {
      if (!this.current || !this.fileId) return;
      if ((await this.options.storage.version(this.fileId)) === this.version) return;
      const { model } = this.options;
      const remote = await this.options.storage.load(this.fileId);
      this.version = remote.version;
      const mine = this.current;
      this.current = model.merge(mine, remote.doc);
      this.saved = model.hasLocalWins(mine, remote.doc) ? remote.doc : this.current;
      this.keepCopy(this.dirty);
      this.set({ doc: this.current });
      if (this.dirty) this.schedule(0);
    }).catch((e: unknown) => {
      if (fileGone(e)) this.reopen();
      else if (needsSignIn(e)) this.set({ saveState: 'signin' });
      // otherwise: a missed refresh is harmless, the next save merges anyway
    });

  /**
   * Stops retrying, makes one last save (sign-out, unmount) and checks that storage holds every
   * change, waiting at most `closeWaitMs`: a Drive that doesn't answer must not keep someone
   * signed in. Resolves true when nothing is left unsaved (otherwise this device's copy keeps
   * it). From here on the device copy is never written again: signing out may have cleared it.
   * A save that lands after the wait removes the copy it left behind.
   */
  async close(): Promise<boolean> {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.loadTimer);
    if (!this.current || !this.fileId) return !this.dirty;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((resolve) => (timer = setTimeout(resolve, this.options.closeWaitMs ?? 5000)));
    const settled = this.enqueue(() => this.settle()).then(
      () => !this.dirty,
      (e: unknown) => (this.failed(e), false),
    );
    const done = await Promise.race([settled, wait.then(() => null)]);
    clearTimeout(timer);
    // Late, the session is usually gone and the check after the save fails; the save itself
    // going through (nothing dirty) is then all that can be known.
    if (done === null) void settled.then(() => !this.dirty && this.forgetSavedCopy());
    return done === true;
  }

  /**
   * Removes this device's copy when storage holds every record in it: kept at sign-out because a
   * save was still under way, it has nothing left to keep. A copy with anything more (written
   * since by a new session of the same account) stays.
   */
  private forgetSavedCopy() {
    const { replica, model } = this.options;
    const copy = replica?.read();
    if (copy && this.saved && !model.hasLocalWins(copy.doc, this.saved)) replica!.clear();
  }

  /**
   * Saves what is left, then makes sure storage holds it. Drive offers no write that happens only
   * if the file is unchanged (DriveStorage), so another device saving in the same instant can
   * overwrite this one's last save; this device then still holds the records and writes them
   * back, before anything that would forget them (sign-out) goes ahead.
   */
  private async settle() {
    const { storage, model } = this.options;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await this.saveRounds();
      if ((await storage.version(this.fileId)) === this.version) return;
      const remote = await storage.load(this.fileId);
      this.version = remote.version;
      const mine = this.current!;
      this.current = model.merge(mine, remote.doc);
      this.saved = model.hasLocalWins(mine, remote.doc) ? remote.doc : this.current;
      this.set({ doc: this.current });
      if (!this.dirty) return;
    }
    throw new SaveConflictError();
  }

  dismissNotice(kind: SyncNotice<Notice>['kind']) {
    this.set({ notices: this.snapshot.notices.filter((n) => n.kind !== kind) });
  }

  private async openOwn(how: OpenMode) {
    const { storage, owner, replica, carry, model } = this.options;
    const startNew = how === 'new';
    // What this tab had open before (a reopen after its file went away) is kept and merged in.
    const before = startNew ? null : this.current && { doc: this.current, fileId: this.fileId || this.reopenedFrom };
    const kept = startNew ? null : (replica?.read() ?? null);
    const shown = this.showCopy(how, kept);
    const refs = await storage.listFiles();
    let doc: Doc;
    let duplicates: Doc[] = [];
    let unchanged = false;
    /** Damaged files passed over, oldest first: they stay in storage, untouched. */
    let unreadable = 0;
    this.duplicates = [];
    if (refs.length === 0) {
      const removed = await storage.listRemoved();
      if (how === 'normal' && removed.length > 0) throw new DocumentRemovedError();
      const copy = replica?.read();
      // A document deleted for good comes back from a device's copy only when asked.
      if (how === 'normal' && copy && model.contentCount(copy.doc) > 0) throw new DocumentMissingError();
      doc = this.options.init();
      if (startNew) {
        // Copies of the documents this one replaces (on other devices and tabs too) stay out of it.
        const replaces = [...removed.map((r) => r.fileId), ...(copy?.fileId ? [copy.fileId] : [])];
        if (replaces.length) doc = model.withReplaces(doc, replaces);
      }
      ({ fileId: this.fileId, version: this.version } = await storage.create(doc));
    } else {
      // The oldest file is the document; any others (two devices creating one at once) are
      // added to it and then moved to the trash. One that can't be read is left alone: it must
      // not keep the document from opening. A file that is damaged (not even a document) is
      // passed over for the next one, and the user is told; a file of a newer version is not.
      const [first, ...others] = refs;
      // This device's copy holds every record of the version it names: if the file is still at
      // that version, there is nothing to download.
      unchanged = others.length === 0 && !!kept?.version && kept.fileId === first!.fileId && kept.version === first!.version;
      if (unchanged) {
        this.fileId = first!.fileId;
        doc = kept!.doc;
        this.version = kept!.version!;
      } else {
        const opened = await this.loadOldestReadable(refs);
        unreadable = opened.at;
        this.fileId = refs[opened.at]!.fileId;
        ({ doc, version: this.version } = opened.loaded);
        for (const other of refs.slice(opened.at + 1)) {
          const loaded = await storage.load(other.fileId).catch(() => null);
          if (!loaded) continue;
          duplicates.push(loaded.doc);
          this.duplicates.push(other.fileId);
        }
      }
    }
    if (owner && model.owner(doc) !== owner) throw new OtherOwnerError();
    // Taken from a copy with changes Drive lacks: what storage holds is not this, so it saves.
    this.saved = unchanged && kept!.unsaved ? null : doc;

    let current = doc;
    for (const d of duplicates) current = model.absorb(current, d);
    // "Start a new document" means new: a copy of a document it replaced, here or on any device, stays out.
    const replaced = new Set(model.replaces(doc));
    const ours = (c: { doc: Doc; fileId?: string } | null | undefined) =>
      !!c && model.owner(c.doc) === model.owner(doc) && !replaced.has(c.fileId ?? '');
    if (startNew || (kept && !ours(kept))) replica?.clear();
    if (ours(kept)) current = model.absorb(current, kept!.doc);
    if (ours(before)) current = model.absorb(current, before!.doc);
    // Edits made to the copy on screen while this open was under way.
    if (shown && ours(kept) && this.current && this.current !== shown) current = model.merge(this.current, current);
    if (!model.hasLocalWins(current, doc) && this.saved === doc) current = doc;
    // A document converted on reading is saved once, so the file no longer needs converting.
    if (model.needsResave?.(doc) && current === doc) current = { ...doc };
    duplicates = [];

    const notices: SyncNotice<Notice>[] = [];
    if (unreadable) notices.push({ kind: 'unreadableFiles', count: unreadable });
    const demo = carry?.();
    const carried = demo ? model.contentCount(demo) : 0;
    if (demo && carried) {
      current = model.absorb(current, demo);
      notices.push({ kind: 'carried', count: carried });
    }
    notices.push(...(model.openNotices?.(doc, current) ?? []));

    this.current = current;
    this.set({ doc: current, notices, saveState: this.dirty ? 'saving' : 'saved' });
    this.keepCopy(this.dirty);
    if (this.dirty) this.schedule(0);
    else void this.removeDuplicates();
  }

  /**
   * The oldest file that can be read, and how many damaged ones came before it. A damaged file
   * is not a document at all (it does not parse, or holds no document); it is passed over and
   * left as it is. A file a newer version wrote, or one too big, is the document: its error
   * stops the open, as does a damaged file when no file after it can be read.
   */
  private async loadOldestReadable(refs: readonly { fileId: string }[]): Promise<{ at: number; loaded: { doc: Doc; version: string } }> {
    for (let at = 0; ; at++) {
      try {
        return { at, loaded: await this.options.storage.load(refs[at]!.fileId) };
      } catch (e) {
        const damaged = e instanceof UnsupportedDocumentError && e.reason !== 'version' && e.reason !== 'tooBig';
        if (!damaged || at === refs.length - 1) throw e;
      }
    }
  }

  /**
   * Puts this device's copy of my document on screen before storage answers, so a reload shows
   * it at once. Only on a first open, and only a copy of this account's. Returns what it showed.
   */
  private showCopy(how: OpenMode, kept: ReplicaCopy<Doc> | null): Doc | null {
    const { owner, model } = this.options;
    if (how !== 'normal' || this.current || !kept || (owner !== undefined && model.owner(kept.doc) !== owner)) return null;
    this.current = kept.doc;
    this.set({ doc: kept.doc, saveState: kept.unsaved ? 'saving' : 'saved' });
    return kept.doc;
  }

  /**
   * Writes this device's copy; with the file's version once there is a file, since the current
   * document always holds every record of that version.
   */
  private keepCopy(unsaved: boolean) {
    const { replica } = this.options;
    // Closed: an open or a save still under way must not write the document back to a device
    // that signing out has just cleared.
    if (!this.current || !replica || this.closed) return;
    const result = replica.write(this.current, unsaved, this.fileId || undefined, this.fileId ? this.version : undefined);
    // Another tab started a new document in place of this one: follow it, as a reopen does.
    if (result === 'replaced') return this.reopen();
    const kept = result === 'kept';
    if (kept !== this.snapshot.copyKept) this.set({ copyKept: kept });
  }

  private async saveRounds() {
    const { model } = this.options;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const toSave = this.current;
      // No file yet (it is being looked up again): the open that follows saves what's pending.
      if (!toSave || toSave === this.saved || !this.fileId) return;
      this.set({ saveState: 'saving' });
      const result = await this.options.storage.save(this.fileId, toSave, this.version);
      if (result.ok) {
        this.version = result.version;
        this.saved = toSave;
        this.keepCopy(this.dirty);
        this.set({ saveState: this.dirty ? 'saving' : 'saved', saveError: null });
        void this.removeDuplicates();
        if (this.dirty) this.schedule(this.options.saveDelayMs ?? 1500);
        return;
      }
      // Another device saved first: take its version, keep my newer records, try again.
      const remote = await this.options.storage.load(this.fileId);
      this.version = remote.version;
      this.current = model.merge(this.current!, remote.doc);
      this.saved = remote.doc;
      this.set({ doc: this.current });
    }
    throw new SaveConflictError();
  }

  private failed(e: unknown) {
    if (fileGone(e)) {
      this.reopen();
      return;
    }
    if (needsSignIn(e)) {
      this.set({ saveState: 'signin' });
      return;
    }
    this.set({ saveState: 'error', saveError: e });
    if (isRetryable(e)) this.schedule(retryDelay(this.attempts++));
  }

  /**
   * The document file went away (another device merged it into an older one and trashed it,
   * or it was deleted): look for the document again, and add what this tab has to it.
   */
  private reopen() {
    if (this.closed) return; // signed out meanwhile: never again, and never with another account
    this.opening = null;
    this.reopenedFrom = this.fileId || this.reopenedFrom;
    this.fileId = '';
    void this.open();
  }

  private async removeDuplicates() {
    const ids = this.duplicates;
    this.duplicates = [];
    for (const id of ids) await this.options.storage.remove(id).catch(() => {}); // the next open tries again
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => void this.flush(), ms);
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => {});
    return run;
  }

  private set(patch: Partial<SyncSnapshot<Doc, Notice>>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
