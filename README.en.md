# dsh-session-recycler

Delete a conversation record from the DeepSeek Harness Web UI, with a trash bin you can restore from or purge. The official UI only offers **archive** (hide from the list, files stay); it has no delete.

## What you get

- **Host half** `lib/index.js` — six JSON routes under `/x-dsh-session-recycler/*`:
  - `GET  /list` — session inventory (title, time, size, cwd, blank / running / locked flags)
  - `POST /delete` — delete
  - `GET  /trash` — trash inventory
  - `POST /trash/restore` — restore
  - `POST /trash/purge` — delete forever
  - `GET  /ping` — self-check
- **Browser half** `lib/client.js` — a "Delete sessions" entry in the sidebar footer; the dialog has two tabs, **Sessions** and **Trash**.

## Install

```sh
# from npm (recommended)
dsh plugin --profile web add dsh-session-recycler

# or straight from GitHub
dsh plugin --profile web add github:iamwuzhanglin/dsh-session-recycler

systemctl restart dsh-web      # bundle-layer changes do not go through HMR
```

Reload the browser page once afterwards (the client bundle rev changed).

It is also installable from the [dsh-market](https://github.com/dsh-market/dsh-market) plugin market — search for `dsh-session-recycler`.

## What delete does

1. A **running** session is refused (`agent.status === 'running'`).
2. A session still held in memory (opened in a tab) is archived first with `archiveSession({ stopActivity: true })`, so it cannot append another turn.
3. A cold session's `session.lock` is probed with `flock`; if another process holds it, the delete is refused.
4. The session directory is `rename`d into the trash at `$DSH_HOME/.session-recycler-trash/<ISO stamp>-<session id>/`, with a `.dsh-session-recycler.json` sidecar (title / cwd / deleted-at).
5. The id is dropped from the registry's **workspace accounting** and pin set (`detachSession` + `unpinSession`). The **archive flag is kept for a live session**: the host exposes no API to evict a Session from its in-memory store, so that ghost row survives in `sessionQuery.listSessions()` until the host restarts — and the Web UI shows every session that belongs to no workspace as "ungrouped". The archive flag is what hides it and what `ArchivedSessionGate` reads to reject its `agent/pre-step`. A cold session, by contrast, has its leftover archive flag cleared.
6. The projection cache `$DSH_HOME/storages/session_projcache/sessions/<id>.json` is parked in the trash entry's `.projcache/` (that row holds the title).
7. `api-session/removed` is emitted so connected pages drop the row without a reload.

> ⚠️ **A deleted live session leaves an invisible ghost row** until `systemctl restart dsh-web`. It is hidden by the archive flag — it does not appear in the list and `ArchivedSessionGate` rejects its `agent/pre-step`, so it cannot be opened into a conversation or write its log again. The delete response carries `liveGhost: true` when this happened.

## Trash

The trash directory is **`$DSH_HOME/.session-recycler-trash/`** — a plain directory, not a file. Each entry is one delete:

```
$DSH_HOME/.session-recycler-trash/
└── 2026-11-03T04-16-51-851Z-session-aaaa.../
    ├── session.v4.jsonl.zstd      # the session log itself
    ├── session.lock
    ├── .projcache/                # parked projection cache (the title)
    └── .dsh-session-recycler.json   # title / cwd / deleted-at
```

From the Trash tab you can select entries and **Restore** (move back to the original workspace directory) or **Delete forever** (`rm -rf`, irreversible). You can also just `ls` that directory in a terminal and `mv` an entry back by hand.

Restore reads the `cwd` out of the session log header to derive the project directory (`projectKey()`, the same algorithm the JSONL backend uses); if it cannot, it falls back to the cwd recorded in the sidecar.

**Restore needs no restart.** It does three things so a connected page updates by itself:

1. `unstashProjectionCache()` — puts the projection cache back under `$DSH_HOME/storages/session_projcache/sessions/`. **The title lives there**; without it a restored session shows only its project directory name.
2. `reattach()` — `readSessionHeader()` reads the cwd → `resolveByPath()` finds the workspace → `attachSession()` re-registers it.
3. `api-session/added` — broadcasts the full summary so the page inserts the row immediately.

It also **clears the archive flag first** — otherwise a session restored from a live delete would stay hidden forever and `ArchivedSessionGate` would keep rejecting its steps.

The only case that needs a manual reload: the page was opened *before* this delete and the host process restarted in between (event broadcasts do not cross processes).

## What "blank" and "locked" mean

- **Blank** — "New session" was clicked but no message was sent. DSH keeps those five initialization events on disk (`session` / `permission/preset` / `sandbox/mode` / `approval/policy` / `subagent/model-selection-policy`) for reuse by `dsh-api-session-controller`'s `reuseLive`. Clicking once and not chatting therefore accumulates them; deleting one loses nothing.
- **Locked** — another process holds that session's `session.lock` `flock`. That may be the dsh main process (a tab has it open) or another dsh instance. Only **cold** sessions are probed; an in-memory session goes through "archive first, then delete", so nothing is damaged.
- **Running** — a turn is in flight. This is the only state that blocks selection.

## Configuration

`cordis.patch.yml`:

```yaml
- id: dsh-session-recycler
  name: dsh-session-recycler
  config:
    trashDir: .session-recycler-trash   # relative to $DSH_HOME
```

## Safety boundaries

- Session ids go through a whitelist regex plus segment-by-segment `realpath` prefix checks, so `../` traversal is impossible.
- It only ever touches paths of the form `$DSH_HOME/sessions/<project>/<session-id>`.
- Two phases: `rename` into the trash first (atomic), and only then is the index cleaned up.
- Index changes go through `workspaceRegistry`'s public API — `workspace.json` is never hand-edited.
- Trash entry names are traversal-checked too.
- The `/x-dsh-session-recycler/*` prefix sits outside the host's `/` and `/api` auth fences, so every route calls `connection.authorizeIndex()` (falling back to a same-origin `Referer`/`Origin` check) before doing anything.

## Tests

```sh
npm test                 # runs all three
node test/host.test.mjs  # host half: list / delete / index cleanup / gates / trash / zstd round-trip
node test/routes.test.mjs# route level: all six endpoints against a real http server
node test/client.test.mjs# browser half: factory, slot, dialog, tabs, opaque background, close
```

## Known limitations

- A running session must be stopped before it can be deleted.
- **A live session's in-memory copy cannot be evicted.** The host's `sessions` service exposes only `get`/`list`; the `detach` closure is owned by `agent-loop`. After a delete the disk and trash are clean, but that session object stays in memory until dsh-web restarts. The plugin keeps the archive flag on to take away both its visibility and its ability to run.
- Image bytes referenced from `attachments/` are not deleted (a separate attachment store owns them).
- The session search index defaults to `:memory:` and is rebuilt on restart, so it needs no handling.
- The `deleted.json` ledger **only affects this plugin's own dialog list**; the Web UI's session list never reads it.

## License

MIT
