export { UnsupportedDocumentError } from './errors';
export type { DocumentModel, SyncNotice } from './model';

export { AuthExpiredError, GoogleAuth, SignInError, type GoogleUser, type Session } from './google/auth';
export {
  CALL_TIMEOUT_MS,
  createFile,
  DriveError,
  FileGoneError,
  getResourceKey,
  listShares,
  readFile,
  readLinkSharedFile,
  shareFile,
  shareWithLink,
  unshareFile,
  writeFile,
  type DriveApp,
  type DriveFile,
  type Share,
} from './google/drive';
export { pickSharedFile, PickerLoadError, type PickerOptions } from './google/picker';

export { DriveStorage } from './storage/DriveStorage';
export { MemoryStorage } from './storage/MemoryStorage';
export { canShare, type SharedWith, type Sharing } from './storage/Sharing';
export { fileGone, isRetryable, needsSignIn, type FileRef, type SaveResult, type Storage, type StorageFailure } from './storage/Storage';

export {
  DocumentMissingError,
  DocumentRemovedError,
  DocumentSync,
  OtherOwnerError,
  SaveConflictError,
  type OpenMode,
  type SaveState,
  type SyncOptions,
  type SyncSnapshot,
} from './sync/DocumentSync';
export { FollowedDocuments, type FollowedDocument, type FollowedState } from './sync/Followed';
export { forgetSavedCopies, LocalReplica, replicaKey, unsavedCopies, type ReplicaAccount, type ReplicaStore } from './sync/Replica';
export { retryDelay } from './sync/retry';
