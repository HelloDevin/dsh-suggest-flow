// Render-level smoke test: executes the client bundle's slot components with a
// minimal React stub so render-time crashes (TDZ, lost declarations, bad hook
// order) are caught before an install. The settings section is flushed through
// its async mount flow (mount effects → RPC → state → re-render) so the
// release-history "update available" branch renders for real; the dock is
// flushed through cache-restore, chip fill/double-click-send and the manual
// refresh swap.
import { readFileSync } from 'node:fs';

const testNodes = [
  { kind: 'user', content: [{ type: 'text', text: '顺便看下注册接口' }] },
  { kind: 'assistant', messageId: 'a1', blocks: [{ kind: 'text', text: '旧回答' }] },
  { kind: 'user', content: [{ type: 'text', text: '帮我修一下登录的 bug' }] },
  { kind: 'assistant', messageId: 'a2', requestConfig: { provider: 'deepseek', model: 'deepseek-flash' },
    blocks: [{ kind: 'text', text: '我先读一下 auth.py' }, { kind: 'tool-call', name: 'read_file' },
      { kind: 'text', text: '找到了,已修复并跑了测试。' }] },
];

function makeReactStub() {
  const slots = [];
  let index = 0;
  const react = {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState(init) {
      const i = index++;
      if (slots[i] === undefined) slots[i] = typeof init === 'function' ? init() : init;
      const set = value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; react.__dirty = true; };
      return [slots[i], set];
    },
    useRef(init) {
      const i = index++;
      if (slots[i] === undefined) slots[i] = { current: init };
      return slots[i];
    },
    // Mount semantics: an effect runs once per slot (stable deps ⇒ once per mount).
    // The slot is allocated UNCONDITIONALLY so hook indices stay identical between
    // effects-off and effects-on passes. Opt in with __runEffects to exercise
    // mount-time effects.
    useEffect(callback) {
      const i = index++;
      slots[i] = true;
      if (react.__runEffects) callback?.();
    },
    useLayoutEffect() {},
    __reset(clear = false) { index = 0; if (clear) slots.length = 0; },
    __dirty: false,
    __runEffects: false,
  };
  return react;
}

const react = makeReactStub();
const feedbackEvents = [];
let draftText = null;
let submits = 0;
const fakeRemote = {
  recommend: async () => ({ ok: true, value: [] }),
  cachedSuggestions: async () => ({ ok: true, value: [{ text: '缓存命中的建议', intent: 'explore' }] }),
  refreshSuggestions: async () => ({ ok: true, value: [{ text: '刷新后的建议一', intent: 'apply' }, { text: '刷新后的建议二', intent: 'expand' }] }),
  chipSettings: async () => ({ ok: true, value: { enabled: true, count: 3, contextTurns: 3, doubleClickSend: true, hideWhenTyping: true, keyboard: true } }),
  applyChipSettings: async () => ({ ok: true, value: { enabled: true, count: 3, contextTurns: 3, doubleClickSend: true, hideWhenTyping: true, keyboard: true } }),
  recordFeedback: async event => { feedbackEvents.push(event); return true; },
  resetMemory: async () => true,
  releaseHistory: async () => ({ ok: true, value: { releases: [
    { version: '9.9.9', date: '2026-11-22' }, { version: '8.8.8', date: '2026-11-21' },
    { version: '7.7.7', date: '2026-11-20' }, { version: '6.6.6', date: '2026-11-19' },
    { version: '5.5.5', date: '2026-11-18' }, { version: '4.4.4', date: '2026-11-17' },
    { version: '0.4.9', date: '2026-11-16' },
  ], checkedAt: Date.now() } }),
};
const registered = [];
const slots = {
  inject(name, factory) { factory(); return () => {}; },
  register(options, Component) { registered.push({ options, Component }); return () => {}; },
};

const requireStub = name => { if (name === 'react') return react; throw new Error(`unexpected require: ${name}`); };
const fakeWindow = { __ModuleLoader__: { load({ factory }) { globalThis.__dshTestModule = factory(requireStub); } } };
new Function('window', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(fakeWindow);
const mod = globalThis.__dshTestModule;

// Minimal DOM stub: the style-tag effect and the keyboard listener both need it.
const styleTags = new Map();
globalThis.document = {
  getElementById: id => styleTags.get(id) ?? null,
  createElement: () => ({ id: '' }),
  head: { appendChild: node => { if (node.id) styleTags.set(node.id, node); } },
  addEventListener: () => {},
  removeEventListener: () => {},
  body: {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

await mod.apply({
  remote: { $mount: async () => {} },
  effect: () => () => {},
  locale: { register() {}, bind: () => key => key },
  inject(keys, cb) { if (keys.includes('remote.suggestFlow')) cb({ get: () => fakeRemote, slots }); },
});

function render(slotName, clear = true) {
  const entry = registered.find(item => item.options.name === slotName);
  if (!entry) throw new Error(`slot not registered: ${slotName}`);
  react.__reset(clear);
  return entry.Component({
    sessionId: 's1',
    useInput: sel => sel({ draft: draftText ?? '', draftRev: 0, phase: 'plain', attachmentIds: [], occurrences: [], queue: [] }),
    useSession: sel => sel({ running: false, removed: false }),
    useConversation: sel => sel({ views: new Map([['chat', { legacy: { nodes: testNodes } }]]) }),
    useProjection: (key, sel) => sel({ next: { provider: 'deepseek', model: 'm' } }),
    inputActions: { setDraft(value) { draftText = value; }, submit() { submits++; } },
    ...(entry.options.inject ? entry.options.inject() : {}),
  });
}

function walk(node, visit, out = []) {
  visit(node, out);
  if (Array.isArray(node)) { for (const kid of node) walk(kid, visit, out); return out; }
  if (node && typeof node === 'object') {
    for (const kid of node.kids ?? []) walk(kid, visit, out);
  }
  return out;
}
const treeText = node => walk(node, (n, out) => { if (typeof n === 'string' || typeof n === 'number') out.push(String(n)); }).join('');
const findNodes = (node, match) => walk(node, (n, out) => { if (typeof n.type === 'string' && match(n)) out.push(n); });

if (!mod.inject || typeof mod.apply !== 'function') throw new Error('client module exports broken');
render('conversation.input.dock');
console.log('ChipsRow rendered ok');

// Flush the dock: mount effects fire, cachedSuggestions resolves through real
// microtask hops, and the chips + direction dot + refresh button render for real.
// The dock keeps ONE continuous slot session through the refresh phase below (the
// stub shares one slot array across components, so components must not interleave).
react.__runEffects = true;
let docked = null;
for (let i = 0; i < 8; i++) {
  react.__dirty = false;
  docked = render('conversation.input.dock', false);
  await new Promise(resolve => setImmediate(resolve));
  if (!react.__dirty) break;
}
const bubbles = findNodes(docked, n => n.type === 'button' && n.props?.className?.includes('dsh-suggest-flow-bubble'));
const refreshBtn = findNodes(docked, n => n.type === 'button' && n.props?.className?.includes('dsh-suggest-flow-refresh'))[0];
const dots = findNodes(docked, n => typeof n.type === 'string' && n.props?.className?.includes('dsh-suggest-flow-dot'));
if (bubbles.length !== 1) throw new Error(`dock flush expected 1 chip, got ${bubbles.length}`);
if (treeText(docked).includes('缓存命中的建议') === false) throw new Error('cached chip text missing from dock render');
if (bubbles[0].props.title !== '缓存命中的建议') throw new Error('chip hover title missing');
if (dots.length !== 1 || !dots[0].props.className.includes('is-explore')) throw new Error('direction dot missing or wrong class');
if (dots[0].props.title !== '深入探索') throw new Error('direction dot zh label missing');
if (!refreshBtn || refreshBtn.props.title !== '换一组建议') throw new Error('refresh button missing or untitled');
if (!feedbackEvents.some(event => event.event === 'shown')) throw new Error('impression feedback not recorded');
console.log('ChipsRow flushed through cache-restore ok');

// Click the chip: fills the draft and records fill feedback.
bubbles[0].props.onClick();
if (draftText !== '缓存命中的建议') throw new Error('chip click did not fill the draft');
if (!feedbackEvents.some(event => event.event === 'fill' && event.text === '缓存命中的建议')) throw new Error('fill feedback not recorded');
// Second click inside the double-tap window: sends (doubleClickSend default on).
bubbles[0].props.onClick();
if (submits !== 1) throw new Error('second chip click did not send');
if (!feedbackEvents.some(event => event.event === 'send' && event.text === '缓存命中的建议')) throw new Error('send feedback not recorded');
console.log('ChipsRow fill / double-click-send ok');

// Manual refresh: click → host RPC → row content swaps (old text gone, new texts in).
react.__dirty = false;
refreshBtn.props.onClick();
if (!react.__dirty) throw new Error('refresh click produced no state update');
let refreshed = null;
for (let i = 0; i < 8; i++) {
  react.__dirty = false;
  refreshed = render('conversation.input.dock', false);
  await new Promise(resolve => setImmediate(resolve));
  if (!react.__dirty) break;
}
const refreshedText = treeText(refreshed);
if (!refreshedText.includes('刷新后的建议一') || !refreshedText.includes('刷新后的建议二')) {
  throw new Error(`refresh did not swap the row: ${refreshedText.slice(0, 200)}`);
}
if (refreshedText.includes('缓存命中的建议')) throw new Error('refresh left stale chip text in the row');
const refreshedBubbles = findNodes(refreshed, n => n.type === 'button' && n.props?.className?.includes('dsh-suggest-flow-bubble'));
const refreshedDots = findNodes(refreshed, n => typeof n.type === 'string' && n.props?.className?.includes('dsh-suggest-flow-dot'));
if (refreshedBubbles.length !== 2) throw new Error(`refresh expected 2 chips, got ${refreshedBubbles.length}`);
if (!refreshedDots.some(dot => dot.props.className.includes('is-apply')) || !refreshedDots.some(dot => dot.props.className.includes('is-expand'))) {
  throw new Error('refreshed chips missing direction dots');
}
console.log('ChipsRow manual refresh swap ok');

// Flush the settings section: release-history RPC resolves through real microtask
// hops and state re-renders the available branch (stub latest 9.9.9 > built 0.1.0).
// clear=true starts a fresh slot session for this component.
render('settings.section');
console.log('SettingsSection rendered ok');
react.__runEffects = true;
let flushed = null;
for (let i = 0; i < 8; i++) {
  react.__dirty = false;
  flushed = render('settings.section', false);
  await new Promise(resolve => setImmediate(resolve));
  if (!react.__dirty) break;
}
const text = treeText(flushed);
if (text.includes('正在检查更新')) throw new Error(`settings flush stuck on loading: ${text.slice(0, 300)}`);
if (!text.includes('可更新到 9.9.9')) throw new Error(`available-state render missing headline: ${text.slice(0, 300)}`);
if (!text.includes('发布于 2026-11-22')) throw new Error('available-state render missing release date');
if (!text.includes('latest')) throw new Error(`available-state render missing latest badge: ${text.slice(0, 600)}`);
if (!text.includes('5.5.5')) throw new Error('available-state render missing the 5th version row');
if (text.includes('4.4.4') || text.includes('0.4.9')) throw new Error('version list renders more than the 5 most recent rows');
if (!text.includes('检查于')) throw new Error('available-state render missing checked-at footer');
console.log('SettingsSection flushed through release flow ok');

// Exit explicitly: the refresh cooldown timer would otherwise keep the loop alive.
process.exit(process.exitCode ?? 0);
