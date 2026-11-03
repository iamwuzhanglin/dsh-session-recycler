// Browser half of dsh-session-recycler.
//
// Adds a "删除会话" row to the sidebar foot. The panel has two tabs:
//   * 会话    — every session the host reports, with checkboxes; confirming
//               deletes the selected records.
//   * 回收站  — what the trash directory holds, with restore / purge actions.
//
// Written in the shape dsh's client loader expects: a closure handed to
// window.__ModuleLoader__ whose "require" answers the shared modules. It must
// never throw at import time: a failing client plugin blanks the whole Web UI.
window.__ModuleLoader__.load({
  id: 'dsh-session-recycler',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const h = React.createElement;

    const BASE = '/x-dsh-session-recycler';

    const I18N = {
      zh: {
        entry: '删除会话',
        entryAria: '删除会话记录',
        title: '会话记录管理',
        subtitle: '删除会话，或从回收站里恢复。',
        tabSessions: '会话',
        tabTrash: '回收站',
        refresh: '刷新',
        selectAll: '全选',
        deselectAll: '取消全选',
        del: '删除所选',
        restore: '恢复',
        purge: '彻底删除',
        cancel: '取消',
        close: '关闭',
        empty: '没有可删除的会话。',
        trashEmpty: '回收站是空的。',
        loading: '正在读取…',
        loadFailed: '读取失败：',
        confirmDeleteOne: '确定删除这 1 个会话？文件会移入回收站，可以再恢复。',
        confirmDeleteMany: '确定删除这 {0} 个会话？文件会移入回收站，可以再恢复。',
        confirmPurge: '彻底删除后无法恢复，确定吗？',
        deleting: '删除中…',
        working: '处理中…',
        doneDelete: '已删除 {0} 个，文件在回收站里。',
        doneRestore: '已恢复 {0} 个，侧栏应已出现（标题从备份的投影缓存还原）。若没看到请刷新页面。',
        donePurge: '已彻底删除 {0} 个。',
        liveGhost: '其中 {0} 个会话当时仍在内存中：已用归档标记隐藏，重启 dsh-web 后彻底消失。',
        donePartial: '完成：成功 {0} 个，失败 {1} 个。',
        running: '运行中',
        blank: '空白',
        locked: '被占用',
        opened: '已打开',
        untitled: '(无标题)',
        trashDirLabel: '回收站目录',
        hintLocked: '被占用 = 另一个进程正持有该会话的写锁，插件会拒绝删除以免损坏数据。',
        hintBlank: '空白 = 点过「新会话」但没发消息，dsh 会留着给下次复用，可以放心删。',
        size: '大小',
        deletedAt: '删除时间',
      },
      en: {
        entry: 'Delete sessions',
        entryAria: 'Manage session records',
        title: 'Session records',
        subtitle: 'Delete sessions, or restore them from the trash.',
        tabSessions: 'Sessions',
        tabTrash: 'Trash',
        refresh: 'Refresh',
        selectAll: 'Select all',
        deselectAll: 'Deselect all',
        del: 'Delete selected',
        restore: 'Restore',
        purge: 'Delete forever',
        cancel: 'Cancel',
        close: 'Close',
        empty: 'No sessions to delete.',
        trashEmpty: 'The trash is empty.',
        loading: 'Loading…',
        loadFailed: 'Load failed: ',
        confirmDeleteOne: 'Delete this 1 session? Files move to the trash and can be restored.',
        confirmDeleteMany: 'Delete these {0} sessions? Files move to the trash and can be restored.',
        confirmPurge: 'Deleting forever cannot be undone. Continue?',
        deleting: 'Deleting…',
        working: 'Working…',
        doneDelete: 'Deleted {0}. Files are in the trash.',
        doneRestore: 'Restored {0}; the sidebar should update on its own. Reload the page if it does not.',
        donePurge: 'Permanently removed {0}.',
        liveGhost: '{0} of them were still live in host memory: hidden by the archive flag, gone for good after a dsh-web restart.',
        donePartial: 'Finished: {0} succeeded, {1} failed.',
        running: 'running',
        blank: 'blank',
        opened: 'open',
        untitled: '(untitled)',
        trashDirLabel: 'Trash directory',
        hintLocked: "Locked = another process holds this session's write lock; deletion is refused to protect the data.",
        hintBlank: 'Blank = "New session" was clicked but no message was sent; dsh keeps it for reuse and it is safe to delete.',
        size: 'Size',
        deletedAt: 'Deleted',
      },
    };

    function currentLang() {
      const tag = String(document.documentElement.lang || navigator.language || 'zh-CN').toLowerCase();
      return tag.startsWith('zh') ? 'zh' : 'en';
    }

    function t(key, ...args) {
      const dict = I18N[currentLang()] || I18N.zh;
      let text = dict[key] ?? I18N.zh[key] ?? key;
      args.forEach((value, index) => {
        text = text.replace('{' + index + '}', String(value));
      });
      return text;
    }

    function fmtTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '-';
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function fmtStamp(stamp) {
      if (typeof stamp !== 'string') return '-';
      const d = new Date(stamp);
      return Number.isNaN(d.getTime()) ? stamp : fmtTime(d.getTime());
    }

    function fmtSize(n) {
      let value = Number(n) || 0;
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
      }
      return i === 0 ? value + ' B' : value.toFixed(1) + ' ' + units[i];
    }

    async function api(path, init) {
      const response = await fetch(BASE + path, {
        headers: { accept: 'application/json', ...(init && init.body ? { 'content-type': 'application/json' } : {}) },
        ...init,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload.error || ('HTTP ' + response.status));
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    /* ------------------------------------------------------------- styles */

    const CSS = [
      // Opaque panel: bg-layer-1 is #fff / #232324 (no alpha), unlike
      // --dsw-specific-menu which carries an alpha channel.
      '.dshSdOverlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);}',
      '.dshSdPanel{width:min(760px,calc(100vw - 32px));max-height:min(82vh,780px);display:flex;flex-direction:column;border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 18px 48px rgba(0,0,0,.36);font-size:13px;line-height:1.5;}',
      '.dshSdHead{display:flex;align-items:flex-start;gap:10px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));}',
      '.dshSdHeadText{flex:1;min-width:0;}',
      '.dshSdTitle{font-size:15px;font-weight:600;}',
      '.dshSdSub{margin-top:3px;color:var(--dsw-alias-label-tertiary,#777);font-size:12px;}',
      '.dshSdTabs{display:flex;gap:4px;padding:8px 16px 0;}',
      '.dshSdTab{border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:6px 12px;border-radius:8px 8px 0 0;opacity:.65;}',
      '.dshSdTab[data-active="1"]{opacity:1;background:rgba(127,127,127,.12);font-weight:600;}',
      '.dshSdToolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));}',
      '.dshSdList{flex:1;min-height:120px;overflow:auto;padding:6px 10px 10px;}',
      '.dshSdRow{display:flex;gap:10px;align-items:flex-start;padding:8px;border-radius:9px;cursor:pointer;}',
      '.dshSdRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.dshSdRow[data-disabled="1"]{opacity:.55;cursor:not-allowed;}',
      '.dshSdMain{flex:1;min-width:0;}',
      '.dshSdName{font-weight:500;word-break:break-word;}',
      '.dshSdMeta{margin-top:2px;color:var(--dsw-alias-label-tertiary,#777);font-size:11.5px;word-break:break-all;}',
      '.dshSdTag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:5px;font-size:10.5px;background:rgba(255,170,0,.16);color:#b26a00;}',
      '.dshSdTag[data-kind="blank"]{background:rgba(90,140,255,.16);color:#2f6bd8;}',
      '.dshSdFoot{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));}',
      '.dshSdStatus{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary,#777);font-size:12px;word-break:break-word;}',
      '.dshSdBtn{border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));background:transparent;color:inherit;border-radius:8px;padding:5px 11px;font:inherit;cursor:pointer;}',
      '.dshSdBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.dshSdBtn:disabled{opacity:.45;cursor:default;}',
      '.dshSdBtn[data-variant="danger"]{border-color:rgba(220,60,60,.5);color:#d33;}',
      '.dshSdBtn[data-variant="primary"]{background:rgba(220,60,60,.12);border-color:rgba(220,60,60,.5);color:#c22;}',
      '.dshSdEntry{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;color:inherit;font:inherit;padding:6px 10px;border-radius:9px;cursor:pointer;text-align:left;}',
      '.dshSdEntry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
      '.dshSdEntryIcon{width:16px;height:16px;flex:none;opacity:.8;}',
      '.dshSdHint{padding:0 16px 8px;color:var(--dsw-alias-label-tertiary,#777);font-size:11.5px;line-height:1.6;word-break:break-all;}',
      '.dshSdRowBtns{display:flex;gap:6px;flex:none;align-items:center;}',
      '.dshSdSmall{border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));background:transparent;color:inherit;border-radius:7px;padding:2px 8px;font:inherit;font-size:11.5px;cursor:pointer;}',
      '.dshSdSmall:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.dshSdSmall[data-variant="danger"]{border-color:rgba(220,60,60,.45);color:#d33;}',
    ].join('\n');

    function ensureStyle() {
      if (document.querySelector('style[data-dsh-session-recycler]') !== null) return;
      const style = document.createElement('style');
      style.dataset.dshSessionDelete = '1';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* -------------------------------------------------------------- state */

    const state = {
      open: false,
      tab: 'sessions',
      loading: false,
      error: null,
      sessions: [],
      selected: new Set(),
      trash: [],
      trashDir: '',
      trashSelected: new Set(),
      busy: false,
      status: '',
    };
    let rerender = () => {};

    /* --------------------------------------------------------------- views */

    function tagFor(session) {
      if (session.running) return h('span', { className: 'dshSdTag' }, t('running'));
      if (session.blank) return h('span', { className: 'dshSdTag', 'data-kind': 'blank' }, t('blank'));
      if (session.locked) return h('span', { className: 'dshSdTag' }, t('locked'));
      if (session.opened) return h('span', { className: 'dshSdTag' }, t('opened'));
      return null;
    }

    function SessionRow({ session }) {
      // Only a running turn blocks deletion. `locked` just means the host still
      // holds the session open in a tab; the host half archives it first and
      // then removes the log, so it stays selectable.
      const blocked = session.running === true;
      const checked = state.selected.has(session.id);
      const onToggle = () => {
        if (blocked) return;
        if (checked) state.selected.delete(session.id);
        else state.selected.add(session.id);
        rerender();
      };
      const label = session.title || t('untitled');
      const meta = [
        fmtTime(session.updatedAt),
        session.size > 0 ? fmtSize(session.size) : null,
        session.cwd || null,
      ].filter(Boolean).join(' · ');
      return h('label', {
        className: 'dshSdRow',
        'data-disabled': blocked ? '1' : '0',
        title: session.id,
      },
        h('input', {
          type: 'checkbox',
          checked,
          disabled: blocked,
          onChange: onToggle,
          style: { marginTop: 3, flex: 'none' },
        }),
        h('div', { className: 'dshSdMain' },
          h('div', { className: 'dshSdName' }, label, tagFor(session)),
          h('div', { className: 'dshSdMeta' }, meta),
        ),
      );
    }

    function TrashRow({ item }) {
      const checked = state.trashSelected.has(item.name);
      return h('div', { className: 'dshSdRow', title: item.dir },
        h('input', {
          type: 'checkbox',
          checked,
          onChange: () => {
            if (checked) state.trashSelected.delete(item.name);
            else state.trashSelected.add(item.name);
            rerender();
          },
          style: { marginTop: 3, flex: 'none' },
        }),
        h('div', { className: 'dshSdMain' },
          h('div', { className: 'dshSdName' }, item.title || t('untitled')),
          h('div', { className: 'dshSdMeta' },
            [t('deletedAt') + ' ' + fmtStamp(item.deletedAt), item.size > 0 ? fmtSize(item.size) : null, item.sessionId].filter(Boolean).join(' · ')),
        ),
        h('div', { className: 'dshSdRowBtns' },
          h('button', {
            type: 'button',
            className: 'dshSdSmall',
            disabled: state.busy,
            onClick: () => { void restore([item.name]); },
          }, t('restore')),
          h('button', {
            type: 'button',
            className: 'dshSdSmall',
            'data-variant': 'danger',
            disabled: state.busy,
            onClick: () => { void purge([item.name]); },
          }, t('purge')),
        ),
      );
    }

    function SessionsTab() {
      const selectable = state.sessions.filter((session) => session.running !== true);
      return h(React.Fragment, null,
        h('div', { className: 'dshSdToolbar' },
          h('button', {
            type: 'button', className: 'dshSdBtn',
            disabled: state.loading || state.busy,
            onClick: () => { void refresh(); },
          }, t('refresh')),
          // One toggle covers both directions: select every selectable
          // session, or drop the selection when they are already all picked.
          h('button', {
            type: 'button', className: 'dshSdBtn',
            disabled: state.loading || state.busy || selectable.length === 0,
            onClick: () => {
              const all = selectable.every((session) => state.selected.has(session.id));
              state.selected.clear();
              if (!all) for (const session of selectable) state.selected.add(session.id);
              rerender();
            },
          }, selectable.length > 0 && selectable.every((session) => state.selected.has(session.id)) ? t('deselectAll') : t('selectAll')),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { opacity: .65, fontSize: 12 } }, state.selected.size + ' / ' + state.sessions.length),
        ),
        h('div', { className: 'dshSdList' },
          state.sessions.length === 0
            ? h('div', { style: { padding: '18px 12px', opacity: .65 } }, state.loading ? t('loading') : t('empty'))
            : state.sessions.map((session) => h(SessionRow, { key: session.id, session })),
        ),
        h('div', { className: 'dshSdHint' },
          t('hintBlank'),
          h('br'),
          t('hintLocked'),
        ),
        h('div', { className: 'dshSdFoot' },
          h('div', { className: 'dshSdStatus' }, state.error ? t('loadFailed') + state.error : state.status),
          h('button', { type: 'button', className: 'dshSdBtn', disabled: state.busy, onClick: close }, t('cancel')),
          h('button', {
            type: 'button', className: 'dshSdBtn', 'data-variant': 'primary',
            disabled: state.busy || state.selected.size === 0,
            onClick: () => { void submit(); },
          }, state.busy ? t('deleting') : t('del') + ' (' + state.selected.size + ')'),
        ),
      );
    }

    function TrashTab() {
      return h(React.Fragment, null,
        h('div', { className: 'dshSdToolbar' },
          h('button', {
            type: 'button', className: 'dshSdBtn',
            disabled: state.loading || state.busy,
            onClick: () => { void refreshTrash(); },
          }, t('refresh')),
          h('button', {
            type: 'button', className: 'dshSdBtn',
            disabled: state.loading || state.busy || state.trash.length === 0,
            onClick: () => {
              const all = state.trash.every((item) => state.trashSelected.has(item.name));
              state.trashSelected.clear();
              if (!all) for (const item of state.trash) state.trashSelected.add(item.name);
              rerender();
            },
          }, state.trash.length > 0 && state.trash.every((item) => state.trashSelected.has(item.name)) ? t('deselectAll') : t('selectAll')),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { opacity: .65, fontSize: 12 } }, state.trashSelected.size + ' / ' + state.trash.length),
        ),
        h('div', { className: 'dshSdList' },
          state.trash.length === 0
            ? h('div', { style: { padding: '18px 12px', opacity: .65 } }, state.loading ? t('loading') : t('trashEmpty'))
            : state.trash.map((item) => h(TrashRow, { key: item.name, item })),
        ),
        h('div', { className: 'dshSdHint' }, t('trashDirLabel') + '：' + (state.trashDir || '-')),
        h('div', { className: 'dshSdFoot' },
          h('div', { className: 'dshSdStatus' }, state.error ? t('loadFailed') + state.error : state.status),
          h('button', { type: 'button', className: 'dshSdBtn', disabled: state.busy, onClick: close }, t('cancel')),
          h('button', {
            type: 'button', className: 'dshSdBtn',
            disabled: state.busy || state.trashSelected.size === 0,
            onClick: () => { void restore([...state.trashSelected]); },
          }, t('restore') + ' (' + state.trashSelected.size + ')'),
          h('button', {
            type: 'button', className: 'dshSdBtn', 'data-variant': 'danger',
            disabled: state.busy || state.trashSelected.size === 0,
            onClick: () => { void purge([...state.trashSelected]); },
          }, t('purge') + ' (' + state.trashSelected.size + ')'),
        ),
      );
    }

    function Panel() {
      const tab = state.tab;
      return h('div', {
        className: 'dshSdOverlay',
        onClick: (event) => { if (event.target === event.currentTarget) close(); },
      },
        h('div', { className: 'dshSdPanel', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'dshSdHead' },
            h('div', { className: 'dshSdHeadText' },
              h('div', { className: 'dshSdTitle' }, t('title')),
              h('div', { className: 'dshSdSub' }, t('subtitle')),
            ),
            h('button', { type: 'button', className: 'dshSdBtn', onClick: close }, t('close')),
          ),
          h('div', { className: 'dshSdTabs' },
            h('button', {
              type: 'button', className: 'dshSdTab', 'data-active': tab === 'sessions' ? '1' : '0',
              onClick: () => { state.tab = 'sessions'; state.status = ''; state.error = null; render(); void refresh(); },
            }, t('tabSessions')),
            h('button', {
              type: 'button', className: 'dshSdTab', 'data-active': tab === 'trash' ? '1' : '0',
              onClick: () => { state.tab = 'trash'; state.status = ''; state.error = null; render(); void refreshTrash(); },
            }, t('tabTrash')),
          ),
          tab === 'trash' ? h(TrashTab) : h(SessionsTab),
        ),
      );
    }

    let host = null;

    function mountRoot() {
      if (host !== null && host.isConnected) return host;
      host = document.createElement('div');
      host.dataset.dshSessionDeleteRoot = '1';
      document.body.appendChild(host);
      return host;
    }

    function render() {
      if (!state.open) {
        if (render.root !== undefined) {
          render.root.unmount();
          render.root = undefined;
        }
        rerender = () => {};
        if (host !== null) {
          host.remove();
          host = null;
        }
        return;
      }
      const root = mountRoot();
      const { createRoot } = require('react-dom/client');
      if (render.root === undefined) render.root = createRoot(root);
      rerender = () => render.root.render(h(Panel));
      render.root.render(h(Panel));
    }

    /* ------------------------------------------------------------- actions */

    async function refresh() {
      state.loading = true;
      state.error = null;
      state.status = t('loading');
      rerender();
      try {
        const payload = await api('/list', { method: 'GET' });
        state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        state.trashDir = payload.trashDir || '';
        state.status = '';
        const known = new Set(state.sessions.map((session) => session.id));
        for (const id of [...state.selected]) if (!known.has(id)) state.selected.delete(id);
      } catch (error) {
        state.error = error.message;
        state.status = '';
      } finally {
        state.loading = false;
        rerender();
      }
    }

    async function refreshTrash(options) {
      const silent = options !== undefined && options.silent === true;
      state.loading = true;
      state.error = null;
      if (!silent) state.status = t('loading');
      rerender();
      try {
        const payload = await api('/trash', { method: 'GET' });
        state.trash = Array.isArray(payload.items) ? payload.items : [];
        state.trashDir = payload.dir || state.trashDir;
        if (!silent) state.status = '';
        const known = new Set(state.trash.map((item) => item.name));
        for (const name of [...state.trashSelected]) if (!known.has(name)) state.trashSelected.delete(name);
      } catch (error) {
        state.error = error.message;
        if (!silent) state.status = '';
      } finally {
        state.loading = false;
        rerender();
      }
    }

    async function submit() {
      const ids = [...state.selected];
      if (ids.length === 0) return;
      const message = ids.length === 1 ? t('confirmDeleteOne') : t('confirmDeleteMany', ids.length);
      if (!window.confirm(message)) return;
      state.busy = true;
      state.status = t('deleting');
      state.error = null;
      rerender();
      try {
        const payload = await api('/delete', { method: 'POST', body: JSON.stringify({ ids }) });
        const results = Array.isArray(payload.results) ? payload.results : [];
        const okCount = results.filter((result) => result.ok).length;
        const failures = results.filter((result) => result.ok !== true);
        const ghosts = results.filter((result) => result.ok && result.liveGhost === true).length;
        state.status = (failures.length === 0
          ? t('doneDelete', okCount)
          : t('donePartial', okCount, failures.length) + ' ' + failures.map((result) => result.id + ': ' + result.error).join('; '))
          + (ghosts > 0 ? ' ' + t('liveGhost', ghosts) : '');
        state.selected.clear();
        await refresh({ silent: true });
      } catch (error) {
        state.error = error.message;
      } finally {
        state.busy = false;
        rerender();
      }
    }

    async function restore(names) {
      if (names.length === 0) return;
      state.busy = true;
      state.status = t('working');
      state.error = null;
      rerender();
      try {
        const payload = await api('/trash/restore', { method: 'POST', body: JSON.stringify({ names }) });
        const results = Array.isArray(payload.results) ? payload.results : [];
        const okCount = results.filter((result) => result.ok).length;
        const failures = results.filter((result) => result.ok !== true);
        state.status = failures.length === 0
          ? t('doneRestore', okCount)
          : t('donePartial', okCount, failures.length) + ' ' + failures.map((result) => result.name + ': ' + result.error).join('; ');
        state.trashSelected.clear();
        await refreshTrash({ silent: true });
      } catch (error) {
        state.error = error.message;
      } finally {
        state.busy = false;
        rerender();
      }
    }

    async function purge(names) {
      if (names.length === 0) return;
      if (!window.confirm(t('confirmPurge'))) return;
      state.busy = true;
      state.status = t('working');
      state.error = null;
      rerender();
      try {
        const payload = await api('/trash/purge', { method: 'POST', body: JSON.stringify({ names }) });
        const results = Array.isArray(payload.results) ? payload.results : [];
        const okCount = results.filter((result) => result.ok).length;
        const failures = results.filter((result) => result.ok !== true);
        state.status = failures.length === 0
          ? t('donePurge', okCount)
          : t('donePartial', okCount, failures.length) + ' ' + failures.map((result) => result.name + ': ' + result.error).join('; ');
        state.trashSelected.clear();
        await refreshTrash({ silent: true });
      } catch (error) {
        state.error = error.message;
      } finally {
        state.busy = false;
        rerender();
      }
    }

    function open(tab) {
      state.open = true;
      state.tab = tab === 'trash' ? 'trash' : 'sessions';
      state.selected.clear();
      state.trashSelected.clear();
      state.status = '';
      state.error = null;
      render();
      if (state.tab === 'trash') void refreshTrash();
      else void refresh();
    }

    function close() {
      state.open = false;
      render();
    }

    /* -------------------------------------------------------------- entry */

    function EntryButton() {
      return h('button', {
        type: 'button',
        className: 'dshSdEntry',
        title: t('entryAria'),
        onClick: () => open('sessions'),
      },
        h('svg', {
          className: 'dshSdEntryIcon',
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          'aria-hidden': 'true',
        },
          h('path', { d: 'M2.5 4.2h11M6.2 4.2V2.9h3.6v1.3M4 4.2l.6 8.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.1' }),
          h('path', { d: 'M6.6 6.6v4.2M9.4 6.6v4.2' }),
        ),
        h('span', null, t('entry')),
      );
    }

    module.exports.name = 'dsh-session-recycler-client';
    module.exports.inject = ['slots'];
    module.exports.apply = function apply(ctx) {
      try {
        ensureStyle();
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-session-recycler', order: 120, label: () => t('entry') },
          EntryButton,
        ));
      } catch (error) {
        try { console.warn('[dsh-session-recycler] sidebar entry unavailable:', error); } catch {}
      }
    };

    module.exports.__openPanel = open;

    return module.exports;
  },
});
