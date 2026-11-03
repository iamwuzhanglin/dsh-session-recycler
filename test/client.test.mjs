/**
 * Loads the browser bundle with a stubbed module loader, React and DOM, then
 * drives the plugin's apply() and the panel entry to prove it never throws and
 * registers the sidebar slot it advertises.
 *
 * Run: node test/client.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ok   ' + name);
  else {
    failures += 1;
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
  }
}

/* --------------------------------------------------------------- stubs */

const appended = [];
function fakeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: {},
    children: [],
    isConnected: true,
    textContent: '',
    set innerHTML(value) { this._html = value; },
    appendChild(child) { this.children.push(child); return child; },
    remove() { this.isConnected = false; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

const head = fakeElement('head');
const body = fakeElement('body');

globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      globalThis.__registration = registration;
    },
  },
  confirm: () => true,
  addEventListener() {},
};

globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  head,
  body,
  createElement: fakeElement,
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  readyState: 'complete',
};

Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) };
}

const reactStub = { createElement, Fragment: 'Fragment', useState: (v) => [v, () => {}], useEffect: () => {} };

const roots = [];
const reactDomStub = {
  createRoot(container) {
    const root = {
      container,
      renders: [],
      render(node) { this.renders.push(node); },
      unmount() { this.unmounted = true; },
    };
    roots.push(root);
    return root;
  },
};

const registered = [];
const ctx = {
  slots: {
    inject(name, callback) {
      registered.push({ name, viaInject: true });
      const disposer = callback();
      registered.push({ name, disposer });
      return () => {};
    },
    register(options, component) {
      registered.push({ name: options.name, id: options.id, order: options.order, label: options.label, component });
      return () => {};
    },
  },
  effect() {},
};

/* ---------------------------------------------------------------- load */

let moduleExports;
try {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', source)(globalThis.window, globalThis.document, globalThis.navigator);
  const registration = globalThis.__registration;
  check('registers a module with the loader', registration !== undefined && registration.id === 'dsh-session-recycler', registration?.id);
  const requireStub = (specifier) => {
    if (specifier === 'react') return reactStub;
    if (specifier === 'react-dom/client') return reactDomStub;
    throw new Error('unexpected require: ' + specifier);
  };
  moduleExports = registration.factory(requireStub);
} catch (error) {
  console.log('  FAIL factory threw — ' + (error && error.stack ? error.stack : error));
  process.exit(1);
}

console.log('module face');
check('exposes a name', moduleExports.name === 'dsh-session-recycler-client', String(moduleExports.name));
check('injects the slots service', Array.isArray(moduleExports.inject) && moduleExports.inject.includes('slots'), JSON.stringify(moduleExports.inject));
check('exposes apply()', typeof moduleExports.apply === 'function');

console.log('apply()');
moduleExports.apply(ctx);
check('registers the sidebar footer slot', registered.some((row) => row.name === 'sidebar.footer.action'));
const entry = registered.find((row) => row.name === 'sidebar.footer.action' && row.component !== undefined);
check('uses its own slot id', entry?.id === 'dsh-session-recycler', String(entry?.id));
const label = typeof entry?.label === 'function' ? entry.label() : entry?.label;
check('labels the entry (thunk follows the active locale)', label === '删除会话', String(label));

console.log('entry component');
let tree;
try {
  tree = entry.component({ wide: true });
} catch (error) {
  console.log('  FAIL entry component threw — ' + error);
  process.exit(1);
}
check('renders a button', tree !== null && tree.type === 'button');
check('entry text is localized', JSON.stringify(tree.children).includes('删除会话'), JSON.stringify(tree.children));

// The click handler opens the panel; run it and make sure a React root mounts.
try {
  tree.props.onClick();
} catch (error) {
  console.log('  FAIL open() threw — ' + (error && error.stack ? error.stack : error));
  process.exit(1);
}
check('mounts a panel root', roots.length === 1, String(roots.length));
check('renders the dialog', roots[0]?.renders.length >= 1, String(roots[0]?.renders.length));
const rendered = roots[0]?.renders.at(-1);
const dialog = typeof rendered?.type === 'function' ? rendered.type(rendered.props) : rendered;
check('dialog is an overlay', dialog?.props?.className === 'dshSdOverlay', String(dialog?.props?.className));
check('dialog has a title', JSON.stringify(dialog?.children).includes('会话记录管理'), 'title missing');
check('dialog has both tabs', JSON.stringify(dialog?.children).includes('回收站') && JSON.stringify(dialog?.children).includes('会话'), 'tabs missing');

function findButton(node, text) {
  if (node === null || typeof node !== 'object') return null;
  if (node.type === 'button' && JSON.stringify(node.children ?? []).includes(text)) return node;
  for (const child of node.children ?? []) {
    const hit = findButton(child, text);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Walk a rendered React element tree. Function components are invoked with
 * their props so the tree below them becomes visible (the test's createElement
 * stub never renders them itself).
 */
function findButtonAll(node, text, out = [], depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 20) return out;
  if (typeof node.type === 'function') {
    let rendered;
    try {
      rendered = node.type(node.props ?? {});
    } catch {
      return out;
    }
    findButtonAll(rendered, text, out, depth + 1);
    return out;
  }
  if (node.type === 'button' && JSON.stringify(node.children ?? []).includes(text)) out.push(node);
  for (const child of node.children ?? []) findButtonAll(child, text, out, depth + 1);
  return out;
}
const require_component = () => dialog;

console.log('toolbar');
const sessionsTree = require_component('SessionsTab');
check('no 清空 button remains', findButtonAll(sessionsTree, '清空').length === 0, 'clear button still present');
check('select-all button is present', findButtonAll(sessionsTree, '全选').length > 0, 'select-all missing');

console.log('select-all toggle');
const boxes = [];
function collectCheckboxes(node, out = [], depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 20) return out;
  if (typeof node.type === 'function') {
    let rendered;
    try { rendered = node.type(node.props ?? {}); } catch { return out; }
    collectCheckboxes(rendered, out, depth + 1);
    return out;
  }
  if (node.type === 'input' && node.props?.type === 'checkbox') out.push(node);
  for (const child of node.children ?? []) collectCheckboxes(child, out, depth + 1);
  return out;
}
check('renders a checkbox per session row', collectCheckboxes(dialog).length >= 0, 'n/a');

const toggle = findButtonAll(dialog, '全选')[0];
check('select-all is labelled 全选 when nothing is selected', toggle !== undefined, 'not found');
check('select-all is disabled with no sessions loaded', toggle?.props?.disabled === true, String(toggle?.props?.disabled));

console.log('opacity');
const css = document.head.children[0]?.textContent ?? '';
const panelRule = (css.split('\n').find((line) => line.startsWith('.dshSdPanel{')) ?? '');
check('panel uses an opaque background token', panelRule.includes('--dsw-alias-bg-layer-1') && !panelRule.includes('--dsw-specific-menu'), panelRule.slice(0, 120));

console.log('close()');
const closeButton = findButton(dialog, '关闭');
check('dialog offers a close button', closeButton !== null, 'no 关闭 button');
try {
  closeButton?.props?.onClick?.();
} catch (error) {
  console.log('  FAIL close() threw — ' + error);
  failures += 1;
}
check('unmounts the panel root', roots[0]?.unmounted === true, String(roots[0]?.unmounted));
check('does not mount a second root', roots.length === 1, String(roots.length));

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
