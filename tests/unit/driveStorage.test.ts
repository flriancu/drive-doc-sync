import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnsupportedDocumentError } from '../../src/errors';
import { AuthExpiredError } from '../../src/google/auth';
import { DriveError, FileGoneError, type DriveApp } from '../../src/google/drive';
import { DriveStorage } from '../../src/storage/DriveStorage';
import { addRecord, newDoc, testModel, type TestDoc } from './testDoc';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string; init: RequestInit };

/** A fake Drive: answers by URL pattern and records every request. */
function fakeDrive(routes: [RegExp, (call: Call) => { status?: number; json?: unknown; text?: string }][]) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      ...(typeof init.body === 'string' && { body: init.body }),
      init,
    };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!route) throw new Error(`unexpected ${call.method} ${url}`);
    const r = route[1](call);
    const status = r.status ?? 200;
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ''), { status });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const APP: DriveApp = { fileName: 'test-app.json', appProperty: { key: 'app', value: 'test_app' } };
const storage = () => new DriveStorage<TestDoc>(() => 'tok', testModel, APP);
const doc = () => addRecord(newDoc('sub-1'), 'a');
/** What a version check fails with. */
const failure = async () =>
  (await storage()
    .version('f1')
    .catch((e: unknown) => e)) as DriveError;

describe('DriveStorage', () => {
  it("finds my document files by the app's property, with the token", async () => {
    const calls = fakeDrive([[/^GET .*\/drive\/v3\/files\?/, () => ({ json: { files: [{ id: 'f1', version: '3' }] } })]]);
    expect(await storage().listFiles()).toEqual([{ fileId: 'f1', ownerName: '', writable: true }]);
    const q = new URL(calls[0]!.url).searchParams.get('q');
    expect(q).toContain("appProperties has { key='app' and value='test_app' }");
    expect(q).toContain("'me' in owners");
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
  });

  it("creates the file with the app's name, property and the written document, in one multipart upload", async () => {
    const calls = fakeDrive([[/^POST .*upload\/drive\/v3\/files\?uploadType=multipart/, () => ({ json: { id: 'new', version: '1' } })]]);
    expect(await storage().create({ ...doc(), converted: 3 })).toEqual({ fileId: 'new', version: '1' });
    const body = calls[0]!.body!;
    expect(calls[0]!.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    expect(body).toContain('"appProperties":{"app":"test_app"}');
    expect(body).toContain('"name":"test-app.json"');
    expect(body).toContain('"owner":"sub-1"');
    expect(body).not.toContain('converted'); // the model's `write` decides what is stored
  });

  it('loads the file through the model', async () => {
    fakeDrive([
      [/fields=version,trashed$/, () => ({ json: { version: '5' } })],
      [/alt=media$/, () => ({ json: { ...doc(), legacy: true } })],
    ]);
    const loaded = await storage().load('f1');
    expect(loaded.version).toBe('5');
    expect(loaded.doc.owner).toBe('sub-1');
    expect(loaded.doc.converted).toBe(1);
  });

  it("passes on the model's refusal of a file it can't use", async () => {
    fakeDrive([
      [/fields=version,trashed$/, () => ({ json: { version: '5' } })],
      [/alt=media$/, () => ({ json: { schemaVersion: 9 } })],
    ]);
    await expect(storage().load('f1')).rejects.toMatchObject({ reason: 'notDoc' });
  });

  it('reports content that is not JSON as a damaged file, not as a Drive problem', async () => {
    fakeDrive([
      [/fields=version,trashed$/, () => ({ json: { version: '5' } })],
      [/alt=media$/, () => ({ text: 'garbage' })],
    ]);
    const e = await storage()
      .load('f1')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnsupportedDocumentError);
    expect((e as UnsupportedDocumentError).reason).toBe('json');
  });

  it('writes when the version is unchanged, and returns the new version', async () => {
    const calls = fakeDrive([
      [/^GET .*fields=version,trashed$/, () => ({ json: { version: '6' } })],
      [/^PATCH .*uploadType=media/, () => ({ json: { version: '7' } })],
    ]);
    expect(await storage().save('f1', doc(), '6')).toEqual({ ok: true, version: '7' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
  });

  it('reports a conflict without writing when another device saved in between', async () => {
    const calls = fakeDrive([[/^GET .*fields=version,trashed$/, () => ({ json: { version: '8' } })]]);
    expect(await storage().save('f1', doc(), '6')).toEqual({ ok: false, conflict: true });
    expect(calls).toHaveLength(1);
  });

  it('never answers from the HTTP cache, never follows redirects, and gives up on a call that hangs', async () => {
    const calls = fakeDrive([[/fields=version,trashed$/, () => ({ json: { version: '5' } })]]);
    await storage().version('f1');
    expect(calls[0]!.init.cache).toBe('no-store');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);

    vi.stubGlobal('fetch', async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const hung = await storage()
      .version('f1')
      .catch((e: unknown) => e);
    expect(hung).toBeInstanceOf(DriveError);
    expect((hung as DriveError).status).toBe(0);
    expect((hung as DriveError).retryable).toBe(true);
  });

  it('reads every page of the file list, oldest first, and keeps only my own files', async () => {
    const calls = fakeDrive([
      [/pageToken=p2/, () => ({ json: { files: [{ id: 'f2', version: '1' }] } })],
      [
        /^GET .*\/drive\/v3\/files\?/,
        () => ({
          json: {
            files: [
              { id: 'f1', version: '3' },
              { id: 'shared', version: '1', ownedByMe: false },
            ],
            nextPageToken: 'p2',
          },
        }),
      ],
    ]);
    expect((await storage().listFiles()).map((c) => c.fileId)).toEqual(['f1', 'f2']);
    expect(new URL(calls[0]!.url).searchParams.get('orderBy')).toBe('createdTime');
  });

  it.each([
    ['an incomplete search', { files: [], incompleteSearch: true }],
    ['no file list at all', {}],
    ['a list that is not a list', { files: null }],
  ])('treats %s as an error, never as "no document yet"', async (_, json) => {
    fakeDrive([[/.*/, () => ({ json })]]);
    await expect(storage().listFiles()).rejects.toBeInstanceOf(DriveError);
  });

  it('notices a file in the trash or gone, instead of writing into it', async () => {
    fakeDrive([[/fields=version,trashed$/, () => ({ json: { version: '6', trashed: true } })]]);
    await expect(storage().save('f1', doc(), '6')).rejects.toEqual(new FileGoneError('trashed'));
    fakeDrive([[/fields=version,trashed$/, () => ({ status: 404, text: 'not found' })]]);
    await expect(storage().version('f1')).rejects.toEqual(new FileGoneError('missing'));
  });

  it('refuses an answer without a version instead of treating it as unchanged', async () => {
    fakeDrive([[/fields=version,trashed$/, () => ({ json: {} })]]);
    await expect(storage().save('f1', doc(), '6')).rejects.toBeInstanceOf(DriveError);
  });

  it('retries Google rate limits (403 with a rate-limit reason), not other refusals', async () => {
    fakeDrive([[/.*/, () => ({ status: 403, text: '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}' })]]);
    expect((await failure()).retryable).toBe(true);
    fakeDrive([[/.*/, () => ({ status: 403, text: '{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}' })]]);
    expect((await failure()).retryable).toBe(false);
  });

  it('gives up on a file list that never ends, and on a listed file without an id', async () => {
    fakeDrive([[/.*/, () => ({ json: { files: [], nextPageToken: 'again' } })]]);
    await expect(storage().listFiles()).rejects.toBeInstanceOf(DriveError);
    fakeDrive([[/.*/, () => ({ json: { files: [{ version: '1' }] } })]]);
    await expect(storage().listFiles()).rejects.toBeInstanceOf(DriveError);
  });

  it('shares my document read-only, lists who it is shared with (not the owner), and stops sharing', async () => {
    const calls = fakeDrive([
      [/^POST .*\/files\/f1\/permissions\?/, () => ({ json: { id: 'perm-1' } })],
      [
        /^GET .*\/files\/f1\/permissions\?/,
        () => ({
          json: {
            permissions: [
              { id: 'o', type: 'user', role: 'owner', emailAddress: 'me@example.test' },
              { id: 'perm-1', type: 'user', role: 'reader', emailAddress: 'ana@example.test', displayName: 'Ana' },
              { id: 'any', type: 'anyone', role: 'reader' },
            ],
          },
        }),
      ],
      [/^DELETE .*\/files\/f1\/permissions\/perm-1$/, () => ({ text: '' })],
    ]);
    await storage().share('f1', 'ana@example.test');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ type: 'user', role: 'reader', emailAddress: 'ana@example.test' });
    expect(new URL(calls[0]!.url).searchParams.get('sendNotificationEmail')).toBe('true');
    expect(await storage().sharedWith('f1')).toEqual([
      { id: 'perm-1', kind: 'user', role: 'reader', email: 'ana@example.test', name: 'Ana' },
      { id: 'any', kind: 'anyone', role: 'reader' },
    ]);
    await storage().unshare('f1', 'perm-1');
    expect(calls.at(-1)!.method).toBe('DELETE');
  });

  it('turns 401 into AuthExpiredError, and passes through an error from the token getter', async () => {
    fakeDrive([[/.*/, () => ({ status: 401, text: 'expired' })]]);
    await expect(storage().listFiles()).rejects.toBeInstanceOf(AuthExpiredError);
    const noToken = new DriveStorage<TestDoc>(
      () => {
        throw new AuthExpiredError();
      },
      testModel,
      APP,
    );
    await expect(noToken.listFiles()).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
