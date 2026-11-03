/**
 * Standalone harness: exercises the host half against a disposable DSH_HOME.
 * Run: node test/host.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-session-recycler-test-'));
process.env.DSH_HOME = home;

const { listSessions, deleteSession, listTrash, restoreTrash, purgeTrash } = await import('../lib/index.js');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
  }
}

const id = 'session-11111111-2222-3333-4444-555555555555';
const other = 'session-99999999-8888-7777-6666-555555555555';
const projectDir = join(home, 'sessions', '--srv-demo--');
for (const sessionId of [id, other]) {
  const dir = join(projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'),
    JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 1, cwd: '/srv/demo', isSeeded: false, delegationDepth: 0 }) + '\n');
  writeFileSync(join(dir, 'session.lock'), '');
}
const projcache = join(home, 'storages', 'session_projcache', 'sessions');
mkdirSync(projcache, { recursive: true });
writeFileSync(join(projcache, id + '.json'), JSON.stringify({ record: { rows: { title: { val: '要被删掉的会话' } } } }));

const registry = {
  removed: [],
  list() {
    return [{
      path: '/srv/demo',
      sessionIds: [id, other],
      detachSession(sessionId) { registry.removed.push(['detach', sessionId]); },
    }];
  },
  async unpinSession(sessionId) { registry.removed.push(['unpin', sessionId]); },
  async unarchiveSession(sessionId) { registry.removed.push(['unarchive', sessionId]); },
};

const headers = [
  { id, createdAt: 1, cwd: '/srv/demo' },
  { id: other, createdAt: 2, cwd: '/srv/demo' },
];
const emitted = [];
const ctx = {
  get(name) {
    if (name === 'sessionQuery') return { listSessions: async () => headers.map((header) => ({ header })) };
    if (name === 'sessions') return { list: () => [], get: () => undefined };
    if (name === 'agents') return { get: () => undefined };
    if (name === 'workspaceRegistry') return registry;
    return undefined;
  },
  emit(event, ...args) { emitted.push([event, ...args]); },
};

console.log('listSessions');
const rows = await listSessions(ctx);
check('returns every session', rows.length === 2, JSON.stringify(rows.map((row) => row.id)));
const target = rows.find((row) => row.id === id);
check('resolves the title from the projection cache', target.title === '要被删掉的会话', String(target.title));
check('marks the session as on disk', target.onDisk === true);
check('reports a byte size', target.size > 0, String(target.size));

console.log('deleteSession');
const result = await deleteSession(ctx, {}, id);
check('reports success', result.ok === true, JSON.stringify(result));
check('moves the directory into the trash', typeof result.trashedTo === 'string' && existsSync(result.trashedTo));
check('removes the original directory', !existsSync(join(projectDir, id)));
check('leaves other sessions alone', existsSync(join(projectDir, other)));
check('detaches from the workspace registry', registry.removed.some(([verb]) => verb === 'detach'));
check('unpins the id', registry.removed.some(([verb]) => verb === 'unpin'));
check('unarchives a cold session (drops a stale flag)', registry.removed.some(([verb]) => verb === 'unarchive'));
check('moves the projection cache row out of the live cache', !existsSync(join(projcache, id + '.json')));
check('emits api-session/removed', emitted.some(([event, payload]) => event === 'api-session/removed' && payload === id));
check('trash keeps exactly one entry', readdirSync(join(home, '.session-recycler-trash')).length === 1);

console.log('guards');
const bad = await deleteSession(ctx, {}, '../../etc');
check('rejects a traversal id', bad.ok === false, JSON.stringify(bad));

const held = {
  ...ctx,
  get(name) {
    if (name === 'agents') return { get: () => ({ status: 'running' }) };
    return ctx.get(name);
  },
};
const running = await deleteSession(held, {}, other);
check('refuses a running session', running.ok === false, JSON.stringify(running));
check('keeps the running session on disk', existsSync(join(projectDir, other)));

// A live-but-idle session (opened in a tab) is archived, then deleted.
const third = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const thirdDir = join(projectDir, third);
mkdirSync(thirdDir, { recursive: true });
writeFileSync(join(thirdDir, 'session.v4.jsonl.zstd'),
  JSON.stringify({ type: 'session', version: 4, id: third, createdAt: 1, cwd: '/srv/demo', isSeeded: false, delegationDepth: 0 }) + '\n');
writeFileSync(join(thirdDir, 'session.lock'), '');
writeFileSync(join(projcache, third + '.json'), JSON.stringify({ record: { rows: {} } }));
const archived = [];
const archivedCleared = [];
const liveCtx = {
  ...ctx,
  get(name) {
    if (name === 'sessions') return { list: () => [], get: (id) => (id === third ? { id } : undefined) };
    if (name === 'workspaceRegistry') return {
      ...registry,
      async archiveSession(sessionId, options) { archived.push([sessionId, options]); },
      async unarchiveSession(sessionId) { archivedCleared.push(sessionId); },
    };
    return ctx.get(name);
  },
};
const liveResult = await deleteSession(liveCtx, {}, third);
check('deletes an idle live session', liveResult.ok === true, JSON.stringify(liveResult));
check('archives before deleting', archived.length === 1 && archived[0][0] === third, JSON.stringify(archived));
check('gates the archive with stopActivity', archived[0]?.[1]?.stopActivity === true, JSON.stringify(archived[0]?.[1]));
check('removes the live session directory', !existsSync(thirdDir));
check('KEEPS the archive flag on a live session (hides the in-memory ghost)', !archivedCleared.includes(third), JSON.stringify(archivedCleared));
check('flags the delete as leaving a live ghost row', liveResult.liveGhost === true, JSON.stringify(liveResult));
check('reports the ghost as actually hidden', liveResult.hidden === true, JSON.stringify(liveResult));
const afterLive = await listSessions(liveCtx);
check('hides the deleted live session from the list', !afterLive.some((row) => row.id === third), JSON.stringify(afterLive.map((r) => r.id)));

const restoredUnarchived = [];
registry.unarchiveSession = async (sessionId) => { registry.removed.push(['unarchive', sessionId]); restoredUnarchived.push(sessionId); };

async function readTitleProbe(sessionId) {
  // After restore the session is no longer live and no longer listed by the
  // fixture ctx (its headers are a fixed array), so read the cache file the
  // way the host does.
  const file = join(home, 'storages', 'session_projcache', 'sessions', sessionId + '.json');
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return parsed?.record?.rows?.title?.val;
}

// A live session whose archive call fails must not claim to be hidden.
const fourth = 'session-bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const fourthDir = join(projectDir, fourth);
mkdirSync(fourthDir, { recursive: true });
writeFileSync(join(fourthDir, 'session.v4.jsonl.zstd'),
  JSON.stringify({ type: 'session', version: 4, id: fourth, createdAt: 1, cwd: '/srv/demo', isSeeded: false, delegationDepth: 0 }) + '\n');
writeFileSync(join(fourthDir, 'session.lock'), '');
const failCtx = {
  ...ctx,
  get(name) {
    if (name === 'sessions') return { list: () => [], get: (id) => (id === fourth ? { id } : undefined) };
    if (name === 'workspaceRegistry') return {
      ...registry,
      async archiveSession() { throw new Error('archive refused'); },
      async unarchiveSession(sessionId) { archivedCleared.push(sessionId); },
    };
    return ctx.get(name);
  },
};
const failResult = await deleteSession(failCtx, {}, fourth);
check('a failed archive still deletes the log', failResult.ok === true, JSON.stringify(failResult));
check('does not claim the ghost is hidden', failResult.hidden === false, JSON.stringify(failResult));
check('does not keep an archive flag it never set', archivedCleared.includes(fourth), JSON.stringify(archivedCleared));
// Keep the trash-count assertions below stable: this probe entry is not part of
// the trash scenario they exercise.
const failEntry = (await listTrash({})).items.find((item) => item.sessionId === fourth);
if (failEntry !== undefined) await purgeTrash({}, failEntry.name);

console.log('trash');
const trash = await listTrash({});
check('lists every trashed entry', trash.items.length === 2, JSON.stringify(trash.items.map((i) => i.name)));
check('reports the trash directory', typeof trash.dir === 'string' && trash.dir.includes('.session-recycler-trash'), String(trash.dir));
check('newest entry first', trash.items[0]?.name > trash.items[1]?.name, JSON.stringify(trash.items.map((i) => i.name)));

const titled = trash.items.find((item) => item.sessionId === id);
check('recovers the title from the delete sidecar', titled?.title === '要被删掉的会话', String(titled?.title));

const restored = await restoreTrash(ctx, {}, titled.name);
check('restores the entry', restored.ok === true, JSON.stringify(restored));
check('unarchives the session it restores', restoredUnarchived.includes(id), JSON.stringify(restoredUnarchived));
check('puts the directory back where it came from', restored.restoredTo === join(projectDir, id), String(restored.restoredTo));
check('the log is back on disk', existsSync(join(projectDir, id)));
check('drops the trash sidecar on restore', !existsSync(join(projectDir, id, '.dsh-session-recycler.json')));
check('the projection cache is restored (title survives)', existsSync(join(projcache, id + '.json')));
check('the restored title is readable again', (await readTitleProbe(id)) === '要被删掉的会话', String(await readTitleProbe(id)));
check('empties that trash slot', !existsSync(join(home, '.session-recycler-trash', titled.name)));

const rejectedName = await restoreTrash(ctx, {}, '../etc');
check('rejects a traversal trash name', rejectedName.ok === false, JSON.stringify(rejectedName));

const purged = await purgeTrash({}, titled.name);
check('purge on a missing entry is a clean failure', purged.ok === false, JSON.stringify(purged));

const trash2 = await listTrash({});
const entry2 = trash2.items[0]?.name;
const purged2 = await purgeTrash({}, entry2);
check('purges a real entry', purged2.ok === true, JSON.stringify(purged2));
check('trash is empty afterwards', (await listTrash({})).items.length === 0);

console.log('zstd round-trip');
const zipId = 'session-55555555-4444-3333-2222-111111111111';
const zipDir = join(projectDir, zipId);
mkdirSync(zipDir, { recursive: true });
const header = JSON.stringify({ type: 'session', version: 4, id: zipId, createdAt: 5, cwd: '/srv/demo', isSeeded: false, delegationDepth: 0 }) + '\n';
const { spawnSync } = await import('node:child_process');
const packed = spawnSync('zstd', ['-q', '-c'], { input: header });
writeFileSync(join(zipDir, 'session.v4.jsonl.zstd'), packed.stdout);
writeFileSync(join(zipDir, 'session.lock'), '');
const zipDeleted = await deleteSession(ctx, {}, zipId);
check('deletes a zstd-backed session', zipDeleted.ok === true, JSON.stringify(zipDeleted));
const zipTrash = await listTrash({});
const zipEntry = zipTrash.items.find((item) => item.sessionId === zipId);
check('zstd entry shows up in the trash', zipEntry !== undefined);
const zipBack = await restoreTrash(ctx, {}, zipEntry.name);
check('restores a zstd session by reading its header', zipBack.ok === true, JSON.stringify(zipBack));
check('zstd log is back in its project dir', existsSync(join(zipDir, 'session.v4.jsonl.zstd')));
await purgeTrash({}, zipEntry.name);

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
