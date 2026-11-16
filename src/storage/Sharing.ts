/**
 * Sharing my document with other people, read-only. Separate from Storage: only storages that
 * live somewhere others can reach have it (Drive yes, the in-memory demo no).
 */
export interface Sharing {
  sharedWith(fileId: string): Promise<SharedWith[]>;
  /** Lets `email` read my document; they are told by their storage (Drive emails them). */
  share(fileId: string, email: string): Promise<void>;
  /** Takes the access away; one already gone counts as done. */
  unshare(fileId: string, sharedWithId: string): Promise<void>;
}

/** One kind of access to my document: a person or group (by address), everyone in a domain, or anyone with the link. */
export interface SharedWith {
  id: string;
  kind: 'user' | 'group' | 'domain' | 'anyone';
  email?: string;
  domain?: string;
  name?: string;
  /** What they may do: `share` gives `reader`; the others were given elsewhere. */
  role: 'reader' | 'commenter' | 'writer';
}

export const canShare = (storage: object): storage is Sharing => typeof (storage as Partial<Sharing>).share === 'function';
