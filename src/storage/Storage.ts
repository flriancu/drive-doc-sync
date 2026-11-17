/** The app's only way to load and save its documents. Drive now; the interface allows others. */
export interface Storage<Doc> {
  /** `memory` never outlives the page (demo, end-to-end tests). */
  readonly kind: 'memory' | 'drive';
  /** My document files, oldest first. Normally there is exactly one. */
  listFiles(): Promise<FileRef[]>;
  /** Files I removed (Drive: in the trash), so the app doesn't start an empty one over them. */
  listRemoved(): Promise<FileRef[]>;
  load(fileId: string): Promise<{ doc: Doc; version: string }>;
  /** The current version only: cheap, to see whether another device saved. */
  version(fileId: string): Promise<string>;
  save(fileId: string, doc: Doc, baseVersion: string): Promise<SaveResult>;
  create(initial: Doc): Promise<{ fileId: string; version: string }>;
  remove(fileId: string): Promise<void>;
}

export interface FileRef {
  fileId: string;
  ownerName: string;
  writable: boolean;
  /** The file's version, when the listing gives it: no separate request needed to compare. */
  version?: string;
}

export type SaveResult = { ok: true; version: string } | { ok: false; conflict: true };

/**
 * What a storage's errors may say about themselves, so callers react to the meaning (try again
 * later, ask the user to sign in) without knowing Drive's errors.
 */
export interface StorageFailure {
  readonly retryable?: boolean;
  readonly needsSignIn?: boolean;
  /** The file is gone (trashed or deleted): look for the document again. */
  readonly fileGone?: boolean;
}

export const isRetryable = (e: unknown): boolean => (e as StorageFailure | null)?.retryable === true;
export const needsSignIn = (e: unknown): boolean => (e as StorageFailure | null)?.needsSignIn === true;
export const fileGone = (e: unknown): boolean => (e as StorageFailure | null)?.fileGone === true;
