/**
 * Route-level integration test: mounts the plugin on a real node:http server
 * through a stub ctx.webServer, then drives every route over HTTP.
 *
 * Run: node test/routes.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-session-recycler-routes-'));
process.env.DSH_HOME = home;

const plugin = await import('../lib/index.js');
const { default: definition } = plugin;

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ok   ' + name);
  else {
    failures += 1;
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
  }
}

/* --------------------------------------------------------------- fixture */

const id = 'session-cccccccc-dddd-eeee-ffff-000000000000';
const projectDir = join(home, 'sessions', '--srv-demo--');
const sessionDir = join(projectDir, id);
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'),
  JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd: '/srv/demo', isSeeded: false, delegationDepth: 0 }) + '\n');
writeFileSync(join(sessionDir, 'session.lock'), '');
mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });

const ctx = {
  routes: [],
  effects: [],
  get(name) {
    if (name === 'sessionQuery') return { listSessions: async () => [{ header: { id, createdAt: 1, cwd: '/srv/demo' } }] };
    if (name === 'sessions') return { list: () => [], get: () => undefined };
    if (name === 'agents') return { get: () => undefined };
    if (name === 'workspaceRegistry') return { list: () => [], unpinSession: async () => {}, unarchiveSession: async () => {} };
    return undefined;
  },
  emit() {},
  effect(fn) { ctx.effects.push(fn()); },
  webServer: {
    register(route) { ctx.routes.push(route); return () => {}; },
  },
};

/* ---------------------------------------------------------------- mount */

// Mirror the host router: longest matching prefix wins (dsh-host-webserver
// match()), not registration order. Registration order would let
// "/trash" shadow "/trash/restore".
const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  let best;
  for (const route of ctx.routes) {
    if (pathname !== route.path && !pathname.startsWith(route.path + '/')) continue;
    if (best === undefined || route.path.length > best.path.length) best = route;
  }
  if (best !== undefined) {
    void best.handler(req, res);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('no route');
});

definition.apply(ctx, { trashDir: '.test-trash' });
check('declares its cordis name', definition.name === 'dsh-session-recycler', String(definition.name));
check('injects the web server', Array.isArray(definition.inject) && definition.inject.includes('webServer'), JSON.stringify(definition.inject));
check('registers six routes', ctx.routes.length === 6, String(ctx.routes.length));
check('serves under one namespace', ctx.routes.every((route) => route.path.startsWith('/x-dsh-session-recycler/')), ctx.routes.map((r) => r.path).join(','));

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const root = 'http://127.0.0.1:' + port;

function request(path, init) {
  return fetch(root + path, {
    ...init,
    headers: { origin: root, ...(init?.headers ?? {}) },
  });
}

function bareRequest(path, init) {
  return fetch(root + path, init);
}

/* ---------------------------------------------------------------- routes */

console.log('GET /ping');
const ping = await request('/x-dsh-session-recycler/ping');
const pingBody = await ping.json();
check('answers 200', ping.status === 200, String(ping.status));
check('names the plugin', pingBody.name === 'dsh-session-recycler', JSON.stringify(pingBody));
check('resolves the trash dir from config', pingBody.trashDir === join(home, '.test-trash'), String(pingBody.trashDir));

console.log('GET /list');
const list = await request('/x-dsh-session-recycler/list');
const listBody = await list.json();
check('answers 200', list.status === 200, String(list.status));
check('lists the session', listBody.sessions.length === 1 && listBody.sessions[0].id === id, JSON.stringify(listBody.sessions?.map((s) => s.id)));

console.log('POST /delete — validation');
const empty = await request('/x-dsh-session-recycler/delete', { method: 'POST', body: JSON.stringify({ ids: [] }) });
check('rejects an empty id list with 400', empty.status === 400, String(empty.status));
const notJson = await request('/x-dsh-session-recycler/delete', { method: 'POST', body: 'not json' });
check('survives a malformed body', notJson.status === 400, String(notJson.status));

console.log('POST /delete — happy path');
const del = await request('/x-dsh-session-recycler/delete', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ids: [id] }),
});
const delBody = await del.json();
check('answers 200', del.status === 200, String(del.status));
check('reports success', delBody.results?.[0]?.ok === true, JSON.stringify(delBody));
check('deletes the directory', !existsSync(sessionDir));
check('parks it in the configured trash', existsSync(join(home, '.test-trash')));

console.log('GET /trash');
const trashBefore = await (await request('/x-dsh-session-recycler/trash')).json();
check('lists the trashed session', trashBefore.items.length === 1, JSON.stringify(trashBefore.items?.map((i) => i.name)));
check('reports the trash dir', trashBefore.dir === join(home, '.test-trash'), String(trashBefore.dir));
const trashedName = trashBefore.items[0]?.name;

console.log('POST /trash/restore');
const restore = await request('/x-dsh-session-recycler/trash/restore', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ names: [trashedName] }),
});
const restoreBody = await restore.json();
check('restores over HTTP', restore.status === 200 && restoreBody.results?.[0]?.ok === true, JSON.stringify(restoreBody));
check('the directory is back', existsSync(sessionDir));

console.log('POST /trash/purge');
const missing = await request('/x-dsh-session-recycler/trash/purge', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ names: [trashedName] }),
});
const missingBody = await missing.json();
check('a restored entry is gone from the trash', missingBody.results?.[0]?.ok !== true, JSON.stringify(missingBody));
const emptyPurge = await request('/x-dsh-session-recycler/trash/purge', { method: 'POST', body: JSON.stringify({ names: [] }) });
check('rejects an empty purge list', emptyPurge.status === 400, String(emptyPurge.status));

console.log('auth guard');
const noOrigin = await bareRequest('/x-dsh-session-recycler/list');
check('refuses a request with no origin', noOrigin.status === 403, String(noOrigin.status));
const crossOrigin = await bareRequest('/x-dsh-session-recycler/list', { headers: { origin: 'http://evil.example' } });
check('refuses a cross-origin request', crossOrigin.status === 403, String(crossOrigin.status));

console.log('routing guards');
const wrongMethod = await request('/x-dsh-session-recycler/list', { method: 'POST', body: '{}' });
check('rejects the wrong method', wrongMethod.status === 404, String(wrongMethod.status));
const unknown = await request('/x-dsh-session-recycler/nope');
check('rejects an unknown path', unknown.status === 404, String(unknown.status));

server.close();
rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
