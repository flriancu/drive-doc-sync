import { UnsupportedDocumentError } from '../errors';
import type { DocumentModel } from '../model';
import { isRetryable, needsSignIn, type Storage } from '../storage/Storage';
import { retryDelay } from './retry';

/**
 * Where a document I follow stands:
 * - `ready`: loaded and current as of the last look;
 * - `stale`: loaded earlier, but the last look failed for a passing reason (offline, Google
 *   busy); what was loaded is still shown, and it is tried again;
 * - `waiting`: never loaded yet, for a passing reason; tried again;
 * - `signIn`: the Google session ended; nothing is shown until I sign in again;
 * - `gone`: no longer shared with me, or deleted;
 * - `unsupported`: not a document this version can read (another file, a newer version);
 * - `tooBig`: far bigger than any real document.
 */
export type FollowedState = 'loading' | 'ready' | 'stale' | 'waiting' | 'signIn' | 'gone' | 'unsupported' | 'tooBig';

/** One document I follow: someone else's, read-only. */
export interface FollowedDocument<Doc> {
  fileId: string;
  state: FollowedState;
  /** Only while `ready` or `stale`: what may be shown. */
  doc?: Doc;
  /** When `doc` was read (ms since 1970), to say how old a stale one is. */
  loadedAt?: number;
  error?: unknown;
}

/**
 * The documents I follow, read-only: each loaded on its own, so one that can't be read never
 * hides the others; `refresh` reloads only those whose version changed (a tab coming back into
 * view). Passing failures are retried with backoff. A document with more than `maxRecords`
 * records (`model.size`) is refused: a broken or hostile file would make every redraw slow.
 * No React and no DOM, like DocumentSync.
 */
export class FollowedDocuments<Doc> {
  private docs = new Map<string, FollowedDocument<Doc> & { version?: string; attempt?: number; timer?: ReturnType<typeof setTimeout> }>();
  private snapshot: readonly FollowedDocument<Doc>[] = [];
  private readonly listeners = new Set<() => void>();
  private ids: string[] = [];

  constructor(
    private readonly storage: Storage<Doc>,
    private readonly model: Pick<DocumentModel<Doc>, 'size'>,
    private readonly maxRecords: number,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  /** Follows exactly these files: new ones load, dropped ones go. */
  async set(fileIds: readonly string[]) {
    this.ids = [...new Set(fileIds)];
    for (const [id, followed] of this.docs) {
      if (this.ids.includes(id)) continue;
      clearTimeout(followed.timer);
      this.docs.delete(id);
    }
    this.emit();
    await Promise.all(this.ids.filter((id) => !this.docs.has(id)).map((id) => this.load(id)));
  }

  private refreshing: Promise<unknown> | null = null;

  /**
   * Reloads the documents that changed since they were read, and retries the ones that failed
   * (also after signing in again). Calls while one runs share it: a burst of events costs one round.
   */
  refresh = (): Promise<unknown> => (this.refreshing ??= this.refreshAll().finally(() => (this.refreshing = null)));

  private refreshAll = () =>
    Promise.all(
      this.ids.map(async (id) => {
        const followed = this.docs.get(id);
        if (followed?.state === 'loading') return;
        try {
          if (followed?.state === 'ready' && followed.version && (await this.storage.version(id)) === followed.version) return;
        } catch (e) {
          this.failed(id, e);
          return;
        }
        await this.load(id);
      }),
    );

  /** Stops every pending retry (the page or the account is going away). */
  dispose() {
    for (const followed of this.docs.values()) clearTimeout(followed.timer);
    this.ids = [];
    this.docs.clear();
  }

  private async load(id: string) {
    const before = this.docs.get(id);
    clearTimeout(before?.timer);
    if (!before) {
      this.docs.set(id, { fileId: id, state: 'loading' });
      this.emit();
    }
    try {
      const { doc, version } = await this.storage.load(id);
      if (!this.ids.includes(id)) return; // unfollowed meanwhile
      if (this.model.size(doc) > this.maxRecords)
        throw new UnsupportedDocumentError(`The document has more than ${this.maxRecords} records`, 'tooBig');
      this.docs.set(id, { fileId: id, state: 'ready', doc, version, loadedAt: this.now() });
      this.emit();
    } catch (e) {
      if (this.ids.includes(id)) this.failed(id, e);
    }
  }

  private failed(id: string, e: unknown) {
    const before = this.docs.get(id);
    clearTimeout(before?.timer);
    const passing = isRetryable(e);
    const state: FollowedState = needsSignIn(e)
      ? 'signIn'
      : passing
        ? before?.doc
          ? 'stale'
          : 'waiting'
        : e instanceof UnsupportedDocumentError
          ? e.reason === 'tooBig'
            ? 'tooBig'
            : 'unsupported'
          : 'gone';
    const keep = state === 'stale' ? { doc: before!.doc, loadedAt: before!.loadedAt } : {};
    const attempt = passing ? (before?.attempt ?? -1) + 1 : undefined;
    const timer = attempt === undefined ? undefined : setTimeout(() => void this.load(id), retryDelay(attempt));
    this.docs.set(id, { fileId: id, state, error: e, ...keep, ...(attempt !== undefined && { attempt, timer }) });
    this.emit();
  }

  private emit() {
    this.snapshot = this.ids.map((id) => {
      const { version: _v, attempt: _a, timer: _t, ...followed } = this.docs.get(id) ?? { fileId: id, state: 'loading' as const };
      return followed;
    });
    for (const listener of this.listeners) listener();
  }
}
