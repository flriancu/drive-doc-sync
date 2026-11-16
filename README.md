# drive-doc-sync

Keeps one JSON document per Google account in that account's own Google Drive, for small
browser-only apps with no server. It covers Google sign-in, reading and saving the file,
merging when two devices saved, a copy on the device, sharing the file, and Google's file
picker for documents others shared.

Used by [vacation_planner](https://github.com/flriancu/vacation_planner) and the providers
directory.

## What the app provides

The package knows nothing about the document's content. The app passes a `DocumentModel`
([src/model.ts](src/model.ts)): how to read and write the file, how to merge two versions record
by record, who owns it, and how many records it has.

```ts
import { DocumentSync, DriveStorage, GoogleAuth, LocalReplica, replicaKey } from 'drive-doc-sync';

const auth = new GoogleAuth(CLIENT_ID, ['openid', 'email', 'profile', DRIVE_FILE], DRIVE_FILE, 'my-app.session');
const storage = new DriveStorage(() => auth.accessToken(sub), model, {
  fileName: 'my-app.json',
  appProperty: { key: 'app', value: 'my_app' },
});
const sync = new DocumentSync({
  storage,
  model,
  init: () => newDocument(sub),
  owner: sub,
  replica: new LocalReplica(replicaKey('my-app', sub), model),
});
await sync.open();
sync.update((doc) => change(doc)); // saved after a short delay; merged on conflict
```

## Parts

| Module | What it does |
|---|---|
| `google/auth` | Sign-in with Google's token client; the session lives in `sessionStorage` per tab, never in `localStorage`. |
| `google/drive` | Drive REST v3 calls: find, read, create, write, trash, share. No HTTP cache, no redirects, 30 s timeout. |
| `google/picker` | Google's file picker, to open a file someone else shared (needed with the `drive.file` permission). |
| `storage/DriveStorage`, `storage/MemoryStorage` | The `Storage` interface on Drive, and in memory for demos and tests. |
| `sync/DocumentSync` | Open, auto-save, merge on conflict, retry with backoff, refresh, close. |
| `sync/Replica` | The device copy in `localStorage`, merged back on the next open. |
| `sync/Followed` | Documents shared with me, read-only, each loaded on its own. |

## Use it from an app

Apps depend on a version tag of this repository; there is no registry. npm 12 installs git
dependencies only when allowed, so the app's `.npmrc` has `allow-git=all`.

```json
"dependencies": { "drive-doc-sync": "github:flriancu/drive-doc-sync#semver:^0.1.0" }
```

The package ships TypeScript sources; the app's Vite build compiles them.

## Develop

Node 24.

```sh
npm install
npm test           # unit tests (Vitest)
npm run typecheck
npm run lint       # oxlint
npm run format     # Prettier
```

On Windows, run the tests from a path with an upper-case drive letter (`C:\...`): started from
`c:\...`, Vitest loads two copies of itself and every test file fails to load.
