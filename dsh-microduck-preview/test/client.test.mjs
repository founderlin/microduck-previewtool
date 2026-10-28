/**
 * Dependency-free smoke test for the Browser half.
 *
 * No DOM and no React installation: a minimal hook runtime renders the
 * registered components once, which catches module-load errors, bad slot
 * registrations and render-time crashes without the DSH page.
 *
 * Run with:  node test/client.test.mjs
 */

import assert from 'node:assert/strict';

// ---------------------------------------------------------- fakes ----
let hookIndex = 0;
const hookState = [];

const ReactStub = {
  createElement(type, props, ...children) {
    const flat = children.length <= 1 ? children[0] : children;
    return { type, props: { ...(props ?? {}), children: flat } };
  },
  useState(initial) {
    const index = hookIndex++;
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial;
    const set = (value) => {
      hookState[index] = typeof value === 'function' ? value(hookState[index]) : value;
    };
    return [hookState[index], set];
  },
  useEffect() { hookIndex += 1; },
  useMemo(factory) { hookIndex += 1; return factory(); },
  useCallback(callback) { hookIndex += 1; return callback; },
  useRef(value) {
    const index = hookIndex++;
    if (!(index in hookState)) hookState[index] = { current: value };
    return hookState[index];
  },
};

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  },
  __ModuleLoader__: {
    load(entry) {
      assert.equal(entry.id, '@local/dsh-microduck-preview');
      globalThis.__microduckClient = entry.factory((name) => {
        if (name === 'react') return ReactStub;
        throw new Error(`unexpected require('${name}')`);
      });
    },
  },
};
globalThis.fetch = async () => {
  throw new Error('fetch is not available in the smoke test');
};

// ---------------------------------------------------------- load ----
await import('../client.js');
const client = globalThis.__microduckClient;
assert.ok(client, 'module registered itself with __ModuleLoader__');
assert.deepEqual(client.inject, ['slots']);
assert.equal(typeof client.apply, 'function');

// ---------------------------------------------------------- apply ----
const injections = new Map();
const registrations = [];
const fakeSlots = {
  inject(key, callback) {
    injections.set(key, callback);
    return () => {};
  },
  register(options, component) {
    registrations.push({ options, component });
    return { options, component };
  },
};

let injectedDocumentPreviews = false;
const fakeCtx = {
  slots: fakeSlots,
  get: () => undefined,
  inject(deps, _callback) {
    // Emulate the shipped web profile WITHOUT the document-previews package.
    assert.deepEqual(deps, ['documentPreviews']);
    injectedDocumentPreviews = true;
    return () => {};
  },
  effect(effect) { return effect(); },
};

client.apply(fakeCtx);

// The plugin is now a Session View plugin: the conversation View replaces the
// former root `main` panel + sidebar icon.
assert.deepEqual([...injections.keys()].sort(), ['conversation.view', 'tool.call.toolview']);
assert.equal(injectedDocumentPreviews, true);

for (const key of injections.keys()) injections.get(key)();
assert.equal(registrations.length, 2);
const byKey = Object.fromEntries(registrations.map((entry) => [
  `${entry.options.name}:${entry.options.id ?? entry.options.key}`,
  entry.component,
]));
assert.ok(byKey['conversation.view:microduck-preview'], 'session View must be registered into conversation.view');
assert.equal(byKey['conversation.view:microduck-preview'], byKey['conversation.view:microduck-preview']);
assert.ok(byKey['tool.call.toolview:duck_preview']);

// The session View must declare itself as a View tab with a label, after the
// shipped chat (0) / trajectory (10) views.
const viewRegistration = registrations.find((entry) => entry.options.name === 'conversation.view');
assert.equal(viewRegistration.options.id, 'microduck-preview');
assert.equal(viewRegistration.options.order, 20);
assert.equal(viewRegistration.options.label, 'Microduck');
assert.ok(!injections.has('main'), 'the root main panel must no longer be claimed');
assert.ok(!injections.has('sidebar.panellist'), 'the sidebar icon must no longer be claimed');

// ---------------------------------------------------------- render ----
function render(component, props) {
  hookIndex = 0;
  hookState.length = 0;
  return component(props);
}

function walk(node, visit, depth = 0) {
  if (node === null || node === undefined || depth > 20) return;
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit, depth)); return; }
  if (typeof node !== 'object') return;
  visit(node);
  if (typeof node.type === 'function') {
    // Expand the child component once so its own markup is covered too.
    walk(render(node.type, node.props), visit, depth + 1);
    return;
  }
  if (node.props) walk(node.props.children, visit, depth);
}

const renders = [
  ['session view (no session)', byKey['conversation.view:microduck-preview'], { sessionId: undefined, viewRequest: null, completeViewRequest: () => {} }],
  ['session view (scoped)', byKey['conversation.view:microduck-preview'], {
    sessionId: 'session-abcd', viewRequest: null, completeViewRequest: () => {}, openView: () => {},
  }],
  ['tool card (start)', byKey['tool.call.toolview:duck_preview'], { callId: 'call-1', phase: 'start', toolName: 'duck_preview' }],
  ['tool card (result)', byKey['tool.call.toolview:duck_preview'], { callId: 'call-1', phase: 'result', toolName: 'duck_preview' }],
];

for (const [label, component, props] of renders) {
  const tree = render(component, props);
  assert.ok(tree, `${label} rendered nothing`);
  let styleTags = 0;
  walk(tree, (node) => { if (node.type === 'style') styleTags += 1; });
  assert.ok(styleTags >= 1, `${label} did not render its stylesheet`);
  const text = JSON.stringify(tree);
  for (const token of ['--dsw-alias-', 'mduck-']) {
    assert.ok(text.includes(token), `${label} missing ${token}`);
  }
  // No raw Harness client package imports and no duplicated app shell.
  assert.ok(!text.includes('dsh-client-ui-primitives'));
}

// The session View renders one tab per action card (no right-hand list column).
{
  const tree = render(byKey['conversation.view:microduck-preview'], { sessionId: 'session-x', viewRequest: null, completeViewRequest: () => {} });
  const markup = JSON.stringify(tree);
  assert.ok(markup.includes('/api/microduck/workbench/'), 'loads the shared workbench');
  assert.ok(markup.includes('session_id=session-x'), 'workbench is scoped to its owning session');
  assert.ok(!markup.includes('mduck-side'), 'the old right-hand task list column is gone');
  assert.ok(markup.includes('Microduck 动作工作台'), 'embedded workbench has an accessible title');
}

console.log('client smoke checks passed');
