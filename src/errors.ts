/**
 * Errors an app's own document code may throw. Plain TypeScript, no browser or Google code, so
 * an app's domain layer can import it (`drive-doc-sync/errors`).
 */

/**
 * A file this app can't use as its document. `reason` is the app's own word for why; the
 * package itself uses `json` (content that is not JSON) and `tooBig` (a followed document over
 * the size limit).
 */
export class UnsupportedDocumentError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}
