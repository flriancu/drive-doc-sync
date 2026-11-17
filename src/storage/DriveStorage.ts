import { UnsupportedDocumentError } from '../errors';
import {
  createFile,
  findFiles,
  getVersion,
  listShares,
  readFile,
  shareFile,
  trashFile,
  unshareFile,
  writeFile,
  type DriveApp,
  type DriveFile,
} from '../google/drive';
import type { DocumentModel } from '../model';
import type { Sharing } from './Sharing';
import type { FileRef, SaveResult, Storage } from './Storage';

const ref = (f: DriveFile): FileRef => ({ fileId: f.id, ownerName: '', writable: true, version: f.version });

/** The file's content; content that isn't JSON is a damaged file, not a Drive problem. */
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UnsupportedDocumentError('The file is not valid JSON.', 'json');
  }
}

/**
 * Documents as JSON files in the user's own Google Drive. `token` returns a valid access token
 * or throws AuthExpiredError, which the app turns into a "reconnect" prompt.
 */
export class DriveStorage<Doc> implements Storage<Doc>, Sharing {
  readonly kind = 'drive';

  constructor(
    private readonly token: () => string,
    private readonly model: Pick<DocumentModel<Doc>, 'read' | 'write'>,
    private readonly app: DriveApp,
  ) {}

  async listFiles(): Promise<FileRef[]> {
    return (await findFiles(this.token(), this.app)).map(ref);
  }

  async listRemoved(): Promise<FileRef[]> {
    return (await findFiles(this.token(), this.app, true)).map(ref);
  }

  async load(fileId: string) {
    const { text, version } = await readFile(this.token(), fileId);
    return { doc: this.model.read(parse(text)), version };
  }

  version(fileId: string): Promise<string> {
    return getVersion(this.token(), fileId);
  }

  /**
   * Drive has no compare-and-swap, so this checks the version first and then writes. Two
   * devices saving within that gap can overwrite each other; the loser still holds its records
   * (in memory and in the device's saved copy) and merges them back on its next save or open.
   */
  async save(fileId: string, doc: Doc, baseVersion: string): Promise<SaveResult> {
    const token = this.token();
    if ((await getVersion(token, fileId)) !== baseVersion) return { ok: false, conflict: true };
    return { ok: true, version: await writeFile(token, fileId, this.model.write(doc)) };
  }

  async create(initial: Doc) {
    const file = await createFile(this.token(), this.app, this.model.write(initial));
    return { fileId: file.id, version: file.version };
  }

  remove(fileId: string): Promise<void> {
    return trashFile(this.token(), fileId);
  }

  sharedWith(fileId: string) {
    return listShares(this.token(), fileId);
  }

  share(fileId: string, email: string) {
    return shareFile(this.token(), fileId, email);
  }

  unshare(fileId: string, sharedWithId: string) {
    return unshareFile(this.token(), fileId, sharedWithId);
  }
}
