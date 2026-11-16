import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveError, FileGoneError, getResourceKey, readLinkSharedFile, shareFile, shareWithLink } from '../../src/google/drive';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(answer: (call: Call) => { status?: number; json?: unknown; text?: string }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      ...(typeof init.body === 'string' && { body: init.body }),
    };
    calls.push(call);
    const r = answer(call);
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ''), { status: r.status ?? 200 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('sharing a file for editing, and by link', () => {
  it('shares with a person as writer when asked, as reader by default', async () => {
    const calls = fakeFetch(() => ({ json: { id: 'p' } }));
    await shareFile('tok', 'f1', 'ana@example.test', 'writer');
    await shareFile('tok', 'f1', 'bob@example.test');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ type: 'user', role: 'writer', emailAddress: 'ana@example.test' });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ type: 'user', role: 'reader', emailAddress: 'bob@example.test' });
  });

  it('shares with anyone who has the link, read-only, without the email flag Drive refuses there', async () => {
    const calls = fakeFetch(() => ({ json: { id: 'anyoneWithLink' } }));
    expect(await shareWithLink('tok', 'f1')).toBe('anyoneWithLink');
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ type: 'anyone', role: 'reader' });
    expect(new URL(calls[0]!.url).searchParams.has('sendNotificationEmail')).toBe(false);
  });

  it("reads a file's resource key, if it has one", async () => {
    fakeFetch(() => ({ json: { resourceKey: '0-abc' } }));
    expect(await getResourceKey('tok', 'f1')).toBe('0-abc');
    fakeFetch(() => ({ json: {} }));
    expect(await getResourceKey('tok', 'f1')).toBeUndefined();
  });
});

describe('reading a link-shared file without signing in', () => {
  it("sends only the app's API key and the resource key, never a user's token", async () => {
    const calls = fakeFetch(() => ({ text: '{"labels":[]}' }));
    expect(await readLinkSharedFile('key-1', 'f1', '0-abc')).toBe('{"labels":[]}');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/drive/v3/files/f1');
    expect(url.searchParams.get('alt')).toBe('media');
    expect(url.searchParams.get('key')).toBe('key-1');
    expect(calls[0]!.headers).toEqual({ 'X-Goog-Drive-Resource-Keys': 'f1/0-abc' });
  });

  it('says a missing file is gone, and passes on any other refusal with Google’s text', async () => {
    fakeFetch(() => ({ status: 404, text: 'not found' }));
    await expect(readLinkSharedFile('key-1', 'f1')).rejects.toEqual(new FileGoneError('missing'));
    fakeFetch(() => ({ status: 403, text: 'API key not valid for this referrer' }));
    const e = await readLinkSharedFile('key-1', 'f1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DriveError);
    expect((e as DriveError).status).toBe(403);
    expect((e as DriveError).message).toContain('API key not valid');
  });
});
