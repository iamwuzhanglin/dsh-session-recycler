/**
 * dsh-session-recycler — host (cordis plugin) half.
 *
 * Registers JSON routes under /x-dsh-session-recycler/* and performs the actual
 * deletion of a session record:
 *
 *   1. refuse sessions that are running right now; archive an idle but still
 *      in-memory Session so it cannot append another turn mid-delete; refuse a
 *      cold Session whose session.lock another process holds;
 *   2. atomically rename the session directory into a local trash folder;
 *   3. drop the id from the workspace registry (accounting + pin); a Session
 *      that is still live in host memory KEEPS its archive flag, because that
 *      flag is the only durable thing hiding its in-memory ghost row and the
 *      pre-step gate that stops it from running;
 *   4. park/drop the projection-cache checkpoint;
 *   5. emit api-session/removed so a connected Web UI updates without reload.
 *
 * Known limit: a live Session cannot be evicted from the host Session store,
 * so its row stays in the host list (hidden by the archive flag) until the
 * host restarts. The plugin's own list hides it via the `deleted.json` ledger.
 *
 * The session log itself is the canonical record (session.v*.jsonl.zstd), so
 * removing the directory is what actually deletes the conversation.
 */
import { readdir, stat, rename, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const name = 'dsh-session-recycler';
const inject = ['webServer'];

const ROUTE_BASE = '/x-dsh-session-recycler';

/* ------------------------------------------------------------------ paths */

function dshHome() {
  const configured = process.env.DSH_HOME;
  if (configured !== undefined && configured.trim() !== '') return resolve(configured);
  return join(homedir(), '.dsh');
}

function sessionsRoot() {
  return join(dshHome(), 'sessions');
}

function storagesRoot() {
  return join(dshHome(), 'storages');
}

function projcacheDir() {
  return join(storagesRoot(), 'session_projcache', 'sessions');
}

/**
 * Ids this plugin deleted while the host still held them in memory.
 *
 * Scope is deliberately narrow: this ledger feeds **only this plugin's own
 * `GET /x-dsh-session-recycler/list`**. A live Session keeps its row in
 * `sessionQuery.listSessions()` even after its log directory is renamed away,
 * so the delete dialog would otherwise offer a ghost row that no longer exists
 * on disk. The Web UI's session list never reads this file — hiding a deleted
 * live session there is the workspace registry's archive set (see
 * `forgetInRegistry`), not this ledger.
 */
function deletedLedgerPath() {
  return join(deletedLedgerDir(), 'deleted.json');
}

/** The ledger lives in a fixed spot on purpose: it is a display aid, not data,
 *  so it must stay readable even if the configured trash directory moves. */
function deletedLedgerDir() {
  return resolve(dshHome(), '.session-recycler-trash');
}

async function readDeletedLedger() {
  try {
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(deletedLedgerPath(), 'utf8'));
    return Array.isArray(parsed?.ids) ? new Set(parsed.ids.filter((id) => typeof id === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

/** Drop one id from the display ledger (a restored session must be visible again). */
async function forgetDeleted(id) {
  const ids = await readDeletedLedger();
  if (!ids.delete(id)) return;
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(deletedLedgerPath(), JSON.stringify({ ids: [...ids] }, null, 2), 'utf8');
  } catch {
    /* display aid only */
  }
}

/** Re-attach a restored session to the workspace that owns its cwd. */
async function reattach(ctx, sessionId) {
  if (ctx === undefined) return false;
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined) return false;
  try {
    const header = await registry.readSessionHeader(sessionId);
    if (header?.cwd === undefined) return false;
    const workspace = await registry.resolveByPath(header.cwd);
    if (workspace === undefined) return false;
    await workspace.attachSession(sessionId);
    return true;
  } catch {
    /* the Web UI can still adopt it on first open */
    return false;
  }
}

async function rememberDeleted(id) {
  const ids = await readDeletedLedger();
  if (ids.has(id)) return;
  ids.add(id);
  try {
    await mkdir(deletedLedgerDir(), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(deletedLedgerPath(), JSON.stringify({ ids: [...ids] }, null, 2), 'utf8');
  } catch {
    /* the ledger is a display convenience; the delete itself already happened */
  }
}

/* -------------------------------------------------------------- trash bin */

/**
 * List what the trash directory currently holds. Each entry is one session
 * directory renamed away by this plugin: "<ISO stamp>-<session id>".
 */
async function listTrash(config) {
  const root = trashRoot(config);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { dir: root, items: [] };
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const match = /^(\d{4}-\d{2}-\d{2}T[0-9-]+Z)-(.*)$/.exec(entry.name);
    const sessionId = match === null ? entry.name : match[2];
    const deletedAt = match === null ? null : match[1];
    const sidecar = await readTrashSidecar(dir);
    items.push({
      name: entry.name,
      dir,
      sessionId,
      deletedAt: sidecar.deletedAt ?? deletedAt,
      size: await dirSize(dir),
      title: sidecar.title ?? null,
      blank: sidecar.blank === true,
      cwd: sidecar.cwd ?? null
    });
  }
  items.sort((left, right) => String(right.name).localeCompare(String(left.name)));
  return { dir: root, items };
}

/** Move one trashed entry back into its original project directory. */
async function restoreTrash(ctx, config, entryName) {
  const root = trashRoot(config);
  if (typeof entryName !== 'string' || entryName === '' || entryName.includes('/') || entryName.includes('..')) {
    return { ok: false, error: '非法回收站条目名' };
  }
  const source = join(root, entryName);
  if (!isInside(source, root) || !existsSync(source)) {
    return { ok: false, error: '回收站里没有这一项' };
  }
  const match = /^(\d{4}-\d{2}-\d{2}T[0-9-]+Z)-(.*)$/.exec(entryName);
  const sessionId = match === null ? entryName : match[2];
  const sidecar = await readTrashSidecar(source);
  let cwd = sidecar.cwd ?? undefined;
  if (cwd === undefined) try {
    // The header carries the cwd the JSONL backend keys its project directory by.
    const { readFile } = await import('node:fs/promises');
    const files = (await readdir(source)).filter((name) => name.startsWith('session.v'));
    if (files.length === 0) return { ok: false, error: '回收站条目里没有会话日志' };
    const raw = await readFile(join(source, files[0]));
    const header = JSON.parse(decompressHeader(raw));
    cwd = header?.cwd;
  } catch (error) {
    return { ok: false, error: '读不出会话头信息：' + String(error?.message ?? error) };
  }
  const projectDir = cwd === undefined ? join(sessionsRoot(), '_no-cwd') : join(sessionsRoot(), projectKey(cwd));
  const target = join(projectDir, sessionId);
  if (existsSync(target)) return { ok: false, error: '原位置已存在同名会话，未覆盖' };
  try {
    await mkdir(projectDir, { recursive: true });
    await rename(source, target);
  } catch (error) {
    return { ok: false, error: '移回失败：' + String(error?.message ?? error) };
  }
  await forgetDeleted(sessionId);
  // The sidecar is trash-only metadata: it must not survive into the restored
  // session directory, where it would look like an active "deleted" marker.
  try {
    await unlink(join(target, '.dsh-session-recycler.json'));
  } catch {
    /* already gone, or a read-only medium: the session itself is fine */
  }
  // A live Session deleted earlier keeps its archive flag on purpose (that flag
  // is what hid the row and gated its pre-step). Restoring must drop it again,
  // otherwise the session comes back permanently hidden and unable to run.
  try {
    await ctx?.get('workspaceRegistry')?.unarchiveSession(sessionId);
  } catch {
    /* an unreadable archive set must not block the restore itself */
  }
  // Put the checkpoint back BEFORE reattaching: the client list reads the
  // durable title from that row, so the session shows its real name instead of
  // its project directory.
  const cacheRestored = await unstashProjectionCache(sessionId, join(target, '.projcache'));
  const attached = await reattach(ctx, sessionId);
  // api-session/added carries the full summary (title, cwd, running), so a
  // connected page inserts the row live instead of waiting for a reload.
  const summary = await buildSummary(ctx, sessionId);
  if (summary !== undefined) {
    try {
      ctx.emit('api-session/added', summary);
    } catch {
      /* a missing listener must not fail the restore */
    }
  }
  return { ok: true, sessionId, restoredTo: target, cacheRestored, attached, live: summary !== undefined };
}

/**
 * Compose the summary payload `api-session/added` expects.
 *
 * The client merges this into its list and renders the durable title from the
 * projection block, so the same shape the host's own list route produces is
 * what makes a restored session appear named without a reload.
 *
 * @returns the summary, or undefined when the session is not readable yet.
 */
async function buildSummary(ctx, sessionId) {
  try {
    const query = ctx.get('sessionQuery');
    if (query === undefined) return undefined;
    const records = await query.listSessions();
    const record = records.find((item) => item.header.id === sessionId);
    if (record === undefined) return undefined;
    const header = record.header;
    const cache = await readCacheRow(sessionId);
    const dir = await findSessionDir(sessionId);
    let updatedAt = header.createdAt;
    let size = 0;
    if (dir !== undefined) {
      size = await dirSize(dir);
      try {
        for (const entry of await readdir(dir)) {
          if (!entry.startsWith('session.v')) continue;
          updatedAt = Math.max(updatedAt, Math.round((await stat(join(dir, entry))).mtimeMs));
        }
      } catch {
        /* keep the header time */
      }
    }
    const agents = ctx.get('agents');
    return {
      sessionId,
      updatedAt,
      agentAvailable: agents?.get(sessionId) !== undefined,
      formatStatus: record.formatStatus ?? 'current',
      running: agents?.get(sessionId)?.status === 'running',
      blank: cache.blank === true,
      ...header.parentSession === undefined ? {} : { parentSessionId: header.parentSession },
      ...header.origin === undefined ? {} : { origin: header.origin },
      ...header.cwd === undefined ? {} : { cwd: header.cwd },
      ...cache.title === undefined && size === 0 ? {} : {
        projections: {
          kind: 'cached',
          asOfSeq: -1,
          values: {
            ...cache.title === undefined ? {} : { title: cache.title },
            sessionListMetadata: { blank: cache.blank === true, lastPromptAt: null }
          }
        }
      }
    };
  } catch {
    return undefined;
  }
}

/** Read the metadata sidecar this plugin writes next to a trashed log. */
async function readTrashSidecar(dir) {
  try {
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(join(dir, '.dsh-session-recycler.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Read the stored cwd out of a live session's log header, if it is readable. */
async function readHeaderCwd(dir) {
  if (dir === undefined) return undefined;
  try {
    const { readFile, readdir } = await import('node:fs/promises');
    const files = (await readdir(dir)).filter((name) => name.startsWith('session.v'));
    if (files.length === 0) return undefined;
    const raw = await readFile(join(dir, files.sort().at(-1)));
    const header = JSON.parse(decompressHeader(raw));
    return typeof header?.cwd === 'string' ? header.cwd : undefined;
  } catch {
    return undefined;
  }
}

/** Decode the first line of a session log (works for zstd and plain JSONL). */
function decompressHeader(raw) {
  let text;
  if (raw.length > 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd) {
    text = spawnSync('zstd', ['-dc'], { input: raw, maxBuffer: 4 << 20 }).stdout?.toString('utf8') ?? '';
  } else {
    text = raw.toString('utf8');
  }
  const line = text.split('\n').find((row) => row.trim() !== '') ?? '';
  return line;
}

/** Permanently drop one trashed entry. */
async function purgeTrash(config, entryName) {
  const root = trashRoot(config);
  if (typeof entryName !== 'string' || entryName === '' || entryName.includes('/') || entryName.includes('..')) {
    return { ok: false, error: '非法回收站条目名' };
  }
  const target = join(root, entryName);
  if (!isInside(target, root) || !existsSync(target)) {
    return { ok: false, error: '回收站里没有这一项' };
  }
  try {
    const { rm } = await import('node:fs/promises');
    await rm(target, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: '删除失败：' + String(error?.message ?? error) };
  }
}

function trashRoot(config) {
  const configured = typeof config?.trashDir === 'string' && config.trashDir.trim() !== ''
    ? config.trashDir.trim()
    : '.session-recycler-trash';
  return resolve(dshHome(), configured);
}

/** Same encoding as the JSONL session backend: one safe path segment per id. */
function encodeSegment(raw) {
  if (raw.length === 0) return raw;
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

function isInside(path, root) {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(r + sep);
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

function assertSessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id) || id.includes('..')) {
    throw new Error('非法会话 ID: ' + JSON.stringify(id));
  }
  return id;
}

/** Locate <sessions>/<project>/<id> across every project directory. */
async function findSessionDir(id) {
  const root = sessionsRoot();
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const names = new Set([id, encodeSegment(id)]);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    for (const candidate of names) {
      const dir = join(root, project.name, candidate);
      if (!isInside(dir, root)) continue;
      try {
        if ((await stat(dir)).isDirectory()) return dir;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSize(target);
      else total += (await stat(target)).size;
    } catch {
      /* raced with another cleanup */
    }
  }
  return total;
}

/** Non-blocking flock probe: true when another process holds session.lock. */
function lockHeld(lockPath) {
  if (!existsSync(lockPath)) return false;
  const probe = spawnSync('flock', ['-n', lockPath, '-c', 'true'], { timeout: 3000 });
  if (probe.error !== undefined || probe.status === null) return false;
  return probe.status !== 0;
}

/* ---------------------------------------------------------------- metadata */

/**
 * Read the projection-cache checkpoint for one session.
 * @returns the durable title (when any) and whether the session never started a turn.
 */
async function readCacheRow(id) {
  const candidates = [id, id.startsWith('session-') ? id.slice(8) : 'session-' + id];
  for (const stem of candidates) {
    const file = join(projcacheDir(), stem + '.json');
    if (!existsSync(file)) continue;
    try {
      const { readFile } = await import('node:fs/promises');
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      const rows = parsed?.record?.rows ?? {};
      const title = typeof rows.title?.val === 'string' && rows.title.val.trim() !== '' ? rows.title.val : undefined;
      const blank = rows.sessionListMetadata?.val?.blank === true;
      return { title, blank };
    } catch {
      /* unreadable cache costs a title, never a row */
    }
  }
  return { title: undefined, blank: false };
}

/** The project directory key the JSONL backend uses for a cwd. Mirrors projectKey(). */
function projectKey(cwd) {
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return '--' + ((readable.replace(/^-+/, '') || 'root').slice(0, 251)) + '--';
}

async function listSessions(ctx) {
  const deleted = await readDeletedLedger();
  const query = ctx.get('sessionQuery');
  const sessions = ctx.get('sessions');
  const agents = ctx.get('agents');
  const liveIds = new Set((sessions?.list() ?? []).map((session) => session.id));

  let headers = [];
  if (query !== undefined) {
    const records = await query.listSessions();
    headers = records.map((record) => record.header);
  } else if (sessions !== undefined) {
    headers = sessions.list().map((session) => session.header);
  }

  const rows = [];
  for (const header of headers) {
    if (deleted.has(header.id)) continue;
    const dir = await findSessionDir(header.id);
    const cache = await readCacheRow(header.id);
    let updatedAt = header.createdAt;
    let size = 0;
    if (dir !== undefined) {
      try {
        const info = await stat(join(dir, 'session.lock'));
        updatedAt = Math.max(updatedAt, Math.round(info.mtimeMs));
      } catch {
        /* no lock file: fall back to the log mtime below */
      }
      try {
        const entries = await readdir(dir);
        const logs = entries.filter((entry) => entry.startsWith('session.v'));
        for (const log of logs) {
          try {
            const info = await stat(join(dir, log));
            updatedAt = Math.max(updatedAt, Math.round(info.mtimeMs));
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      size = await dirSize(dir);
    }
    rows.push({
      id: header.id,
      title: cache.title ?? null,
      blank: cache.blank || (header.eventCount === 0),
      cwd: header.cwd ?? null,
      createdAt: header.createdAt,
      updatedAt,
      origin: header.origin ?? null,
      size,
      onDisk: dir !== undefined,
      opened: liveIds.has(header.id),
      running: agents?.get(header.id)?.status === 'running',
      locked: dir !== undefined && lockHeld(join(dir, 'session.lock'))
    });
  }
  rows.sort((left, right) => right.updatedAt - left.updatedAt);
  return rows;
}

/* ---------------------------------------------------------------- deletion */

/**
 * Drop a deleted id from the workspace registry.
 *
 * Order matters. Detaching the id from every workspace removes its accounting
 * slot, and — because the Web UI puts every session that belongs to no
 * workspace into the "ungrouped" bucket — that alone is what used to make a
 * deleted session reappear as an ungrouped row. The registry-global archive set
 * is the only durable hide + the pre-step gate
 * (`ArchivedSessionGate`), so a live Session must STAY archived after the
 * delete: unarchiving it here would undo the archive taken in
 * `deleteSession` and resurrect the row on the next list refresh.
 *
 * A cold Session has no live row to hide (its log is gone), so a stale archive
 * flag left over from an earlier user archive is dropped instead.
 *
 * @param ctx - host context carrying `workspaceRegistry`.
 * @param id - session id being removed.
 * @param options.keepArchived - true when the Session is still live in memory.
 */
async function forgetInRegistry(ctx, id, options = {}) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined) return;
  for (const workspace of registry.list()) {
    if (workspace.sessionIds.includes(id)) await workspace.detachSession(id);
  }
  await registry.unpinSession(id);
  if (options.keepArchived !== true) await registry.unarchiveSession(id);
}

/**
 * Move a session's projection-cache checkpoint into the trash entry instead of
 * deleting it. The checkpoint holds the durable title and the blank flag, and
 * the client list reads titles from exactly this row — dropping it is what made
 * a restored session come back unnamed.
 * @returns how many cache files were parked.
 */
async function stashProjectionCache(id, stashDir) {
  const bare = id.startsWith('session-') ? id.slice(8) : id;
  let moved = 0;
  for (const stem of new Set([id, bare])) {
    const file = join(projcacheDir(), stem + '.json');
    if (!isInside(file, projcacheDir()) || !existsSync(file)) continue;
    try {
      await mkdir(stashDir, { recursive: true });
      await rename(file, join(stashDir, stem + '.json'));
      moved += 1;
    } catch {
      /* a cache miss only costs the title; never block the delete */
    }
  }
  return moved;
}

/** Put a parked projection-cache checkpoint back where the host reads it. */
async function unstashProjectionCache(id, stashDir) {
  let restored = 0;
  let names;
  try {
    names = await readdir(stashDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      await mkdir(projcacheDir(), { recursive: true });
      await rename(join(stashDir, name), join(projcacheDir(), name));
      restored += 1;
    } catch {
      /* the host rebuilds a missing checkpoint from the log on first open */
    }
  }
  return restored;
}

async function dropProjectionCache(id) {
  const bare = id.startsWith('session-') ? id.slice(8) : id;
  let removed = 0;
  for (const stem of new Set([id, bare])) {
    const file = join(projcacheDir(), stem + '.json');
    if (!isInside(file, projcacheDir()) || !existsSync(file)) continue;
    try {
      await unlink(file);
      removed += 1;
    } catch {
      /* leave it; a stale cache is discarded on open anyway */
    }
  }
  return removed;
}

async function deleteSession(ctx, config, rawId) {
  let id;
  try {
    id = assertSessionId(rawId);
  } catch (error) {
    return { id: String(rawId), ok: false, error: String(error?.message ?? error) };
  }

  const sessions = ctx.get('sessions');
  const live = sessions?.get(id) !== undefined;
  const agent = ctx.get('agents')?.get(id);
  if (agent?.status === 'running') {
    return { id, ok: false, error: '该会话正在运行，请先停止它再删除。' };
  }
  // A Session the host still holds in memory (opened in a tab) keeps its own
  // flock, so the lock probe is only meaningful for cold Sessions. For a live
  // one, archive it first: the durable archive set gates agent/pre-step, so the
  // session cannot start another turn and rewrite the log we are deleting.
  // Whether the archive flag is really on afterwards — the delete below keeps
  // it only if this is true, so a failed archive never silently leaves an
  // un-hidden ghost row behind.
  let archivedForDelete = false;
  if (live) {
    try {
      await ctx.get('workspaceRegistry')?.archiveSession(id, { stopActivity: true });
      archivedForDelete = true;
    } catch {
      /* unknown-to-registry sessions archive as a no-op error: deletion still proceeds */
    }
  }

  const dir = await findSessionDir(id);
  const cacheBefore = await readCacheRow(id);
  const headerCwd = await readHeaderCwd(dir);
  let trashedTo;
  let cacheFiles;
  if (dir !== undefined) {
    const lock = join(dir, 'session.lock');
    if (!live && lockHeld(lock)) {
      return { id, ok: false, error: '会话锁被占用（另有进程正在写入），已拒绝删除。' };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(trashRoot(config), stamp + '-' + id);
    try {
      await mkdir(trashRoot(config), { recursive: true });
      await rename(dir, target);
      trashedTo = target;
      // The projection cache is about to be dropped, so keep the display facts
      // beside the trashed log: the trash tab needs them to show a name.
      try {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(target, '.dsh-session-recycler.json'), JSON.stringify({
          id,
          title: cacheBefore.title ?? null,
          blank: cacheBefore.blank === true,
          cwd: headerCwd ?? null,
          deletedAt: new Date().toISOString()
        }, null, 2), 'utf8');
      } catch {
        /* a missing sidecar costs a title in the trash list, nothing else */
      }
      // Park the projection-cache checkpoint inside the trash entry: it carries
      // the durable title the client list renders.
      cacheFiles = await stashProjectionCache(id, join(target, '.projcache'));
    } catch (error) {
      return { id, ok: false, error: '移动会话目录失败：' + String(error?.message ?? error) };
    }
  }

  let registryError;
  try {
    // A live Session cannot be evicted from the host's in-memory Session store
    // (the store exposes no public detach), so its row survives in
    // sessionQuery.listSessions() until the host restarts. Keeping the archive
    // flag is what keeps that ghost row out of the sidebar and keeps its
    // pre-step rejected; dropping it would show the row as "ungrouped".
    await forgetInRegistry(ctx, id, { keepArchived: archivedForDelete });
  } catch (error) {
    registryError = String(error?.message ?? error);
  }
  // The checkpoint was parked with the entry above; a cold session has none.
  if (cacheFiles === undefined) cacheFiles = await dropProjectionCache(id);

  if (live) await rememberDeleted(id);

  try {
    ctx.emit('api-session/removed', id);
  } catch {
    /* a missing listener must not fail the delete */
  }

  return {
    id,
    ok: true,
    trashedTo: trashedTo ?? null,
    cacheFiles,
    // The log is gone either way; only the in-memory replica of a live Session
    // needs a host restart to disappear for good.
    ...(live ? {
      liveGhost: true,
      // Only an archived ghost is actually hidden; say which case this was.
      hidden: archivedForDelete,
      note: archivedForDelete
        ? '该会话仍在宿主内存中：已用归档标记隐藏，重启 dsh-web 后彻底消失。'
        : '该会话仍在宿主内存中，且归档失败——重启 dsh-web 后才会消失，期间可能仍可见。'
    } : {}),
    ...(registryError === undefined ? {} : { registryError })
  };
}

/* ------------------------------------------------------------------ routes */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Reject requests that did not come from an authenticated browser session.
 *
 * The plugin's own prefix is outside the host's "/" and "/api" auth fences, so
 * without this check any local process (or anyone reaching the port) could
 * delete sessions. `ctx.connection` exposes the browser-session verifier the
 * host itself uses; when it is absent (older builds) we fall back to a
 * same-origin check on the Referer/Origin pair, which still blocks a plain
 * cross-site form post.
 *
 * @returns true when the request may proceed; otherwise the response is sent.
 */
function guard(ctx, req, res) {
  const connection = ctx.get('connection');
  if (connection !== undefined && typeof connection.authorizeIndex === 'function') {
    // authorizeIndex owns the response when it returns false (401/303), which
    // is exactly the behaviour we want for a non-browser caller.
    return connection.authorizeIndex(req, res, false) === true;
  }
  const origin = req.headers.origin ?? req.headers.referer;
  if (typeof origin !== 'string' || origin === '') {
    json(res, 403, { ok: false, error: 'forbidden: no origin' });
    return false;
  }
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    json(res, 403, { ok: false, error: 'forbidden: bad origin' });
    return false;
  }
  if (host !== req.headers.host) {
    json(res, 403, { ok: false, error: 'forbidden: cross-origin' });
    return false;
  }
  return true;
}

function readBody(req, limit = 1 << 20) {
  return new Promise((settle) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) data = data.slice(0, limit);
    });
    req.on('end', () => {
      try {
        settle(JSON.parse(data || '{}'));
      } catch {
        settle({});
      }
    });
    req.on('error', () => settle({}));
  });
}

/**
 * Register one method+path pair under the plugin namespace.
 * @returns nothing; registration is owned by the calling fiber.
 */
function route(ctx, config, method, path, handler) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_BASE + path,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method !== method || url.pathname !== ROUTE_BASE + path) {
        json(res, 404, { ok: false, error: 'not found' });
        return;
      }
      try {
        if (!guard(ctx, req, res)) return;
        await handler(req, res, url);
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    }
  }), name + ': ' + method + ' ' + ROUTE_BASE + path);
}

function apply(ctx, config = {}) {
  route(ctx, config, 'GET', '/list', async (_req, res) => {
    const sessions = await listSessions(ctx);
    json(res, 200, {
      ok: true,
      sessions,
      trashDir: trashRoot(config),
      sessionsRoot: sessionsRoot(),
      canTrash: true
    });
  });

  route(ctx, config, 'POST', '/delete', async (req, res) => {
    const body = await readBody(req);
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
    if (ids.length === 0) {
      json(res, 400, { ok: false, error: '缺少 ids' });
      return;
    }
    const results = [];
    for (const id of ids) {
      try {
        results.push(await deleteSession(ctx, config, id));
      } catch (error) {
        results.push({ id, ok: false, error: String(error?.message ?? error) });
      }
    }
    json(res, 200, {
      ok: results.every((result) => result.ok),
      results
    });
  });

  route(ctx, config, 'GET', '/trash', async (_req, res) => {
    const { dir, items } = await listTrash(config);
    json(res, 200, { ok: true, dir, items });
  });

  route(ctx, config, 'POST', '/trash/restore', async (req, res) => {
    const body = await readBody(req);
    const names = Array.isArray(body?.names) ? body.names.filter((name) => typeof name === 'string') : [];
    if (names.length === 0) {
      json(res, 400, { ok: false, error: '缺少 names' });
      return;
    }
    const results = [];
    for (const entryName of names) {
      try {
        results.push({ name: entryName, ...(await restoreTrash(ctx, config, entryName)) });
      } catch (error) {
        results.push({ name: entryName, ok: false, error: String(error?.message ?? error) });
      }
    }
    json(res, 200, { ok: results.every((result) => result.ok), results });
  });

  route(ctx, config, 'POST', '/trash/purge', async (req, res) => {
    const body = await readBody(req);
    const names = Array.isArray(body?.names) ? body.names.filter((name) => typeof name === 'string') : [];
    if (names.length === 0) {
      json(res, 400, { ok: false, error: '缺少 names' });
      return;
    }
    const results = [];
    for (const entryName of names) {
      try {
        results.push({ name: entryName, ...(await purgeTrash(config, entryName)) });
      } catch (error) {
        results.push({ name: entryName, ok: false, error: String(error?.message ?? error) });
      }
    }
    json(res, 200, { ok: results.every((result) => result.ok), results });
  });

  route(ctx, config, 'GET', '/ping', async (_req, res) => {
    json(res, 200, { ok: true, name, version: '0.2.2', trashDir: trashRoot(config) });
  });
}

export { deleteSession, listSessions, listTrash, restoreTrash, purgeTrash };

export default { name, inject, apply };
