/**
 * Something the app tells the user once a document is open, e.g. "3 records were set aside".
 * The package's own: 'carried' (records added from `carry`), 'unreadableFiles' (document files
 * that could not be read and were left alone in storage), 'replacedChanges' (this tab followed a
 * document started in its place elsewhere; changes it had not saved to the old one were left).
 */
export interface SyncNotice<K extends string = string> {
  kind: K | 'carried' | 'unreadableFiles' | 'replacedChanges';
  count: number;
}

/**
 * What the package needs to know about an app's document. Every function is pure. Records are
 * merged by time, so applying a merge or an absorb twice changes nothing.
 */
export interface DocumentModel<Doc, Notice extends string = string> {
  /** A document from a file's parsed content; throws UnsupportedDocumentError when it can't. */
  read(raw: unknown): Doc;
  /** The document as it is stored. */
  write(doc: Doc): unknown;
  /** Two versions of the same document, record by record; on a tie `remote` wins. */
  merge(local: Doc, remote: Doc): Doc;
  /** True when `merge(local, remote)` keeps something of `local` that `remote` lacks. */
  hasLocalWins(local: Doc, remote: Doc): boolean;
  /**
   * Another version of my document, possibly created with other ids (a second file, a device
   * copy, a signed-out demo), added into mine. For two versions of one file this is `merge`.
   */
  absorb(into: Doc, from: Doc): Doc;
  /** The Google account id (`sub`) the document belongs to. */
  owner(doc: Doc): string;
  /** Ids of files this document replaced ("start a new one"): copies of those stay out of it. */
  replaces(doc: Doc): readonly string[];
  withReplaces(doc: Doc, fileIds: readonly string[]): Doc;
  /**
   * The user's own records worth keeping: a device copy holding any is not dropped without
   * asking, and a demo's are carried into the account at sign-in.
   */
  contentCount(doc: Doc): number;
  /** Records drawn when the document is followed read-only (checked against a size limit). */
  size(doc: Doc): number;
  /** The document as read needs one save even without changes (e.g. an old format converted). */
  needsResave?(opened: Doc): boolean;
  /** Notices about the document just opened (`current`: after duplicates and copies were added). */
  openNotices?(opened: Doc, current: Doc): SyncNotice<Notice>[];
}
