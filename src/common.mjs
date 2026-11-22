export const PACKAGE = 'dsh-suggest-flow';
export const SERVICE = 'suggestFlow';
export const CONTEXT_LIMITS = { latest: { user: 400, assistant: 1200 }, older: { user: 200, assistant: 500 }, tools: 140 };
export const SUGGESTION_LIMITS = { maxItems: 4, maxChars: 80, minKeyChars: 4 };
export const INTENTS = ['explore', 'expand', 'apply'];
// Host-side refresh policy: one RPC per click, but bounded. Mirrored client-side
// as a soft gate; the host stays authoritative.
export const REFRESH_COOLDOWN_MS = 6000;
export const REFRESH_MAX_PER_REPLY = 5;
export const SHOWN_HISTORY_MAX = 12;
export const CONFIG_KEYS = ['enabled', 'doubleClickSend', 'hideWhenTyping', 'keyboard', 'count', 'contextTurns', 'timeoutMs', 'provider', 'model'];

// Keep the topic and the closing next step; omit code locally, without a summary model call.
export function compactContext(text, limit) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let fence = null;
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; kept.push('[代码略]'); }
    else kept.push(line);
  }
  const characters = Array.from(kept.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  if (characters.length <= limit) return characters.join('');
  const separator = '\n[中间略]\n';
  const available = limit - separator.length;
  const head = Math.floor(available / 3);
  return characters.slice(0, head).join('') + separator + characters.slice(-(available - head)).join('');
}

export function normalizeIntent(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  return INTENTS.includes(text) ? text : undefined;
}

// Chip-text hygiene: strip wrapper quotes/fences and markdown emphasis, collapse
// whitespace runs and repeated closing punctuation. Returns '' when unusable.
export function normalizeSuggestionText(value, maxChars = SUGGESTION_LIMITS.maxChars) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (text.startsWith('```')) return '';
  text = text.replace(/^["“「『]|["”」』]$/g, '').trim();
  if (!text || /[\r\n]/.test(text) || text.startsWith('/')) return '';
  text = text.replace(/\*\*/g, '');
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/([？！?!。，,.\s])\1+$/g, '$1').trim();
  if (!text || text.length > maxChars) return '';
  return text;
}

// Comparison key for dedupe/echo checks: lowercase, all punctuation, symbols and
// whitespace removed, so “重启服务？” and "重启服务" collapse together.
export function normalizeKey(text) {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

// Local junk gate, no extra model call: assistant-voice phrases and generic
// sign-offs that models emit to pad the count. Substring match on the
// normalized key keeps the list short while covering word-order variants.
const JUNK_KEY_PATTERNS = [
  '还有什么', '还有其他', '还有别的', '其他问题', '欢迎继续', '希望对你', '祝你', '如果还有',
  '随时问我', '有需要随时', '我可以帮', '需要我帮忙', '作为ai', '是一个ai', 'ai助手',
  'anythingelse', 'letmeknow', 'hopethishelps', 'feelfree', 'asanai', 'askmeanything',
];

function isJunkKey(key) {
  return JUNK_KEY_PATTERNS.some(pattern => key.includes(pattern));
}

// Accept a string, the compact wire shape {t, i}, or the verbose {text, intent}.
export function normalizeSuggestionObject(value, maxChars = SUGGESTION_LIMITS.maxChars) {
  if (typeof value === 'string') {
    const text = normalizeSuggestionText(value, maxChars);
    return text ? { text } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const raw = typeof value.t === 'string' ? value.t : typeof value.text === 'string' ? value.text : '';
  const text = normalizeSuggestionText(raw, maxChars);
  if (!text) return null;
  const intent = normalizeIntent(typeof value.i === 'string' ? value.i : value.intent);
  return intent ? { text, intent } : { text };
}

// Round-robin across directions: explore → expand → apply → untagged, then second
// picks, so one direction can not occupy every slot while a different one is
// available. Applied even when everything fits — mixed order reads more diverse.
export function diversify(items, count) {
  const queues = INTENTS.map(intent => items.filter(item => item.intent === intent));
  queues.push(items.filter(item => !item.intent));
  const result = [];
  for (let round = 0; result.length < count; round++) {
    let offered = false;
    for (const queue of queues) {
      if (result.length >= count) break;
      if (round < queue.length) { result.push(queue[round]); offered = true; }
    }
    if (!offered) break;
  }
  return result;
}

// Parse the model output into at most `count` clean, deduplicated candidates.
// Accepts a JSON array of strings or {t, i} objects (possibly inside a fence or
// prose), and falls back to plain lines. `context.latestUser` enables the
// user-echo filter; `context.avoid` re-filters already-shown texts (refresh).
export function parseSuggestions(raw, count, context = {}) {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return [];
  const fenced = text.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const collected = [];
  const attempt = source => {
    try {
      const parsed = JSON.parse(source);
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) collected.push(item);
    } catch { /* fall through to line splitting */ }
  };
  attempt(fenced);
  if (!collected.length) {
    const start = fenced.indexOf('[');
    const end = fenced.lastIndexOf(']');
    if (start !== -1 && end > start) attempt(fenced.slice(start, end + 1));
  }
  let items = collected;
  if (!items.length) {
    items = fenced.split(/[\r\n]+/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, ''));
  }
  const userKey = context.latestUser ? normalizeKey(context.latestUser) : '';
  const avoidKeys = new Set((Array.isArray(context.avoid) ? context.avoid : [])
    .map(avoidText => normalizeKey(String(avoidText))).filter(Boolean));
  const kept = [];
  for (const item of items) {
    const clean = normalizeSuggestionObject(item);
    if (!clean) continue;
    const key = normalizeKey(clean.text);
    // Too short to carry a concrete follow-up ("为什么" alone says nothing new).
    if (key.length < SUGGESTION_LIMITS.minKeyChars) continue;
    // Assistant-voice / generic sign-off padding, plus meta-list headers from the
    // plain-line fallback ("以下是建议：") — never a sendable follow-up.
    if (isJunkKey(key) || /^以下是/.test(clean.text) || /[:：]$/.test(clean.text)) continue;
    // Echo of the user's own latest question, verbatim or as a fragment.
    if (userKey && (key === userKey || userKey.includes(key))) continue;
    // Already-shown suggestions must not come back (manual refresh).
    if (avoidKeys.has(key)) continue;
    // Exact or containment duplicate of something we already kept.
    let duplicate = false;
    for (const existing of kept) {
      if (existing.key === key || existing.key.includes(key) || key.includes(existing.key)) { duplicate = true; break; }
    }
    if (duplicate) continue;
    kept.push({ ...clean, key });
    if (kept.length >= count * 2) break; // enough surplus for diversification
  }
  return diversify(kept, count).map(({ key, ...clean }) => clean);
}

function toolLabel(block) {
  if (!block || typeof block !== 'object') return '';
  const name = block.name ?? block.tool ?? block.toolName ?? block.title ?? '';
  return typeof name === 'string' ? name.trim().slice(0, 40) : '';
}

// Collect up to `maxTurns` recent (user, assistant) turns, newest first.
// Tool-call turns qualify: the assistant text plus a compact tool-activity line
// gives the recommender enough context during agent runs.
export function selectContext(nodes, sessionId, selectedModel, maxTurns = 3) {
  if (!Array.isArray(nodes)) return null;
  const turns = [];
  let meta = null; // provider/model + replyId come from the newest usable assistant node
  let i = nodes.length - 1;
  while (i >= 0 && turns.length < maxTurns) {
    const node = nodes[i];
    if (!node || typeof node !== 'object' || node.kind !== 'assistant') { i -= 1; continue; }
    const blocks = Array.isArray(node.blocks) ? node.blocks : [];
    const text = blocks.filter(block => block && block.kind === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n').trim();
    const tools = blocks.filter(block => block && block.kind === 'tool-call').map(toolLabel).filter(Boolean)
      .join(', ').slice(0, CONTEXT_LIMITS.tools);
    if (!text && !tools) { i -= 1; continue; }
    let user = '';
    let boundary = i - 1;
    while (boundary >= 0) {
      const candidate = nodes[boundary];
      if (!candidate || typeof candidate !== 'object') { boundary -= 1; continue; }
      if (candidate.kind === 'user' || candidate.kind === 'steering') {
        const content = Array.isArray(candidate.content) ? candidate.content : [];
        user = content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text).join('\n');
        break;
      }
      if (candidate.kind === 'assistant') break; // consecutive assistant nodes share the user above them
      boundary -= 1;
    }
    if (!meta) {
      const model = node.requestConfig ?? node.providerMetadata ?? selectedModel;
      if (model?.provider && model?.model) meta = { provider: model.provider, model: model.model, replyId: String(node.messageId ?? node.seq) };
    }
    const limits = turns.length === 0 ? CONTEXT_LIMITS.latest : CONTEXT_LIMITS.older;
    turns.push({ user: compactContext(user, limits.user), assistant: compactContext(text, limits.assistant), ...(tools ? { tools } : {}) });
    i = boundary;
  }
  if (!meta || !turns.length) return null;
  return { sessionId, replyId: meta.replyId, provider: meta.provider, model: meta.model, turns };
}

export function validateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid recommendation input');
  const allowed = new Set(['sessionId', 'replyId', 'provider', 'model', 'turns']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError('Unknown recommendation field');
  for (const key of ['sessionId', 'replyId', 'provider', 'model']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 512) throw new TypeError(`Invalid ${key}`);
  }
  if (!Array.isArray(value.turns) || value.turns.length === 0 || value.turns.length > 4) throw new TypeError('Invalid turns');
  for (const turn of value.turns) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new TypeError('Invalid turn');
    if (Object.keys(turn).some(key => key !== 'user' && key !== 'assistant' && key !== 'tools')) throw new TypeError('Unknown turn field');
    if (typeof turn.user !== 'string' || turn.user.length > 2000) throw new TypeError('Invalid turn user');
    if (typeof turn.assistant !== 'string' || turn.assistant.length > 12000) throw new TypeError('Invalid turn assistant');
    if (!turn.assistant.trim() && !turn.tools) throw new TypeError('Empty turn');
    if (turn.tools !== undefined && (typeof turn.tools !== 'string' || turn.tools.length > 200)) throw new TypeError('Invalid turn tools');
  }
  return { ...value, turns: value.turns.map(turn => ({ ...turn })) };
}

export function validateConfigValue(key, value) {
  switch (key) {
    case 'enabled': case 'doubleClickSend': case 'hideWhenTyping': case 'keyboard':
      if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`);
      return value;
    case 'count': case 'contextTurns':
      if (!Number.isInteger(value) || value < 1 || value > 4) throw new TypeError(`${key} must be an integer between 1 and 4`);
      return value;
    case 'timeoutMs':
      if (!Number.isInteger(value) || value < 1000 || value > 60000) throw new TypeError('timeoutMs must be an integer between 1000 and 60000');
      return value;
    case 'provider': case 'model':
      if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${key} must be a nonempty string`);
      return value;
    default:
      throw new TypeError(`Unknown config key: ${key}`);
  }
}

export function validateConfigPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid config patch');
  const patch = {};
  // Unknown keys are dropped, not rejected: a newer client may send keys an older
  // host does not know, and failing the whole patch would desync the settings UI.
  for (const [key, item] of Object.entries(value)) {
    if (!CONFIG_KEYS.includes(key)) continue;
    patch[key] = validateConfigValue(key, item);
  }
  return patch;
}

export function validateClientConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid client config');
  for (const key of ['enabled', 'doubleClickSend', 'hideWhenTyping']) {
    if (typeof value[key] !== 'boolean') throw new TypeError(`Invalid ${key}`);
  }
  if (value.keyboard !== undefined && typeof value.keyboard !== 'boolean') throw new TypeError('Invalid keyboard');
  if (!Number.isInteger(value.count) || value.count < 1 || value.count > 4) throw new TypeError('Invalid count');
  if (!Number.isInteger(value.contextTurns) || value.contextTurns < 1 || value.contextTurns > 4) throw new TypeError('Invalid contextTurns');
  return { enabled: value.enabled, count: value.count, contextTurns: value.contextTurns, doubleClickSend: value.doubleClickSend, hideWhenTyping: value.hideWhenTyping, keyboard: value.keyboard !== false };
}

export function validateSuggestions(value) {
  if (!Array.isArray(value) || value.length > SUGGESTION_LIMITS.maxItems) throw new TypeError('Invalid suggestions');
  return value.map(item => {
    const clean = normalizeSuggestionObject(item);
    if (!clean) throw new TypeError('Invalid suggestion item');
    return clean;
  });
}

export function descriptor() {
  return {
    id: `${PACKAGE}#recommend`, service: SERVICE, namespace: SERVICE, method: 'recommend',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: {
      mode: 'strict', typeSymbol: `${PACKAGE}#Input`, create: () => ({ parse: validateInput }),
    } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#Suggestions`, create: () => ({ parse: validateSuggestions }) },
  };
}

// Manual refresh: same input contract as recommend, same result shape.
export function refreshSuggestionsDescriptor() {
  const base = descriptor();
  return { ...base, id: `${PACKAGE}#refreshSuggestions`, method: 'refreshSuggestions' };
}

export function cachedSuggestionsDescriptor() {
  const base = descriptor();
  return { ...base, id: `${PACKAGE}#cachedSuggestions`, method: 'cachedSuggestions' };
}

export function configDescriptor() {
  return { id: `${PACKAGE}#chipSettings`, service: SERVICE, namespace: SERVICE, method: 'chipSettings',
    invocation: { kind: 'direct' }, parameters: [], cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#ClientConfig`, create: () => ({ parse: validateClientConfig }) } };
}

export function setConfigDescriptor() {
  return { id: `${PACKAGE}#applyChipSettings`, service: SERVICE, namespace: SERVICE, method: 'applyChipSettings',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'patch', wire: 'patch', source: 'json', codec: {
      mode: 'strict', typeSymbol: `${PACKAGE}#ConfigPatch`, create: () => ({ parse: validateConfigPatch }),
    } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#ClientConfig`, create: () => ({ parse: validateClientConfig }) } };
}

export const FEEDBACK_EVENTS = ['shown', 'fill', 'send'];

export function validateFeedback(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid feedback');
  const allowed = new Set(['sessionId', 'replyId', 'event', 'text']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError('Unknown feedback field');
  for (const key of ['sessionId', 'replyId']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 512) throw new TypeError(`Invalid ${key}`);
  }
  if (!FEEDBACK_EVENTS.includes(value.event)) throw new TypeError('Invalid feedback event');
  if (value.text !== undefined && (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 200)) throw new TypeError('Invalid feedback text');
  return { sessionId: value.sessionId, replyId: value.replyId, event: value.event, ...(value.text !== undefined ? { text: value.text.trim() } : {}) };
}

export function feedbackDescriptor() {
  return { id: `${PACKAGE}#recordFeedback`, service: SERVICE, namespace: SERVICE, method: 'recordFeedback',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'event', wire: 'event', source: 'json', codec: {
      mode: 'strict', typeSymbol: `${PACKAGE}#Feedback`, create: () => ({ parse: validateFeedback }),
    } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#Ack`, create: () => ({ parse: value => {
      if (value !== true) throw new TypeError('Unexpected result'); return value;
    } }) } };
}

export function resetMemoryDescriptor() {
  return { id: `${PACKAGE}#resetMemory`, service: SERVICE, namespace: SERVICE, method: 'resetMemory',
    invocation: { kind: 'direct' }, parameters: [], cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#Ack`, create: () => ({ parse: value => {
      if (value !== true) throw new TypeError('Unexpected result'); return value;
    } }) } };
}

// --- Release history for the settings-page 版本 section ---

const RELEASE_TAG_RE = /^v?(\d+\.\d+\.\d+)$/;

export function compareVersions(a, b) {
  const left = String(a).split('.'), right = String(b).split('.');
  for (let i = 0; i < 3; i++) {
    const x = Number(left[i] ?? 0), y = Number(right[i] ?? 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// GitHub Releases API payload → clean [{version, date}] newest-first. Drafts,
// pre-releases, non-semver tags and duplicates are dropped; date is the local
// (viewer's timezone) YYYY-MM-DD so 发布于 matches what the user expects.
export function parseReleases(payload, cap = 20) {
  if (!Array.isArray(payload)) return [];
  const seen = new Set();
  const list = [];
  for (const release of payload) {
    if (!release || typeof release !== 'object' || release.draft === true || release.prerelease === true) continue;
    const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
    const match = RELEASE_TAG_RE.exec(tag);
    if (!match || seen.has(match[1])) continue;
    const parsed = Date.parse(release.published_at ?? '');
    let date = null;
    if (Number.isFinite(parsed)) {
      const local = new Date(parsed);
      date = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    }
    seen.add(match[1]);
    list.push({ version: match[1], date });
  }
  list.sort((a, b) => compareVersions(b.version, a.version));
  return list.slice(0, cap);
}

export function validateReleaseHistory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid release history');
  if (!Number.isFinite(value.checkedAt)) throw new TypeError('Invalid checkedAt');
  if (!Array.isArray(value.releases) || value.releases.length > 20) throw new TypeError('Invalid releases');
  for (const release of value.releases) {
    if (!release || typeof release !== 'object' || !RELEASE_TAG_RE.test(release.version ?? '')
      || (release.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(release.date ?? ''))) throw new TypeError('Invalid release entry');
  }
  return { releases: value.releases.map(({ version, date }) => ({ version, date })), checkedAt: value.checkedAt };
}

export function releaseHistoryDescriptor() {
  return { id: `${PACKAGE}#releaseHistory`, service: SERVICE, namespace: SERVICE, method: 'releaseHistory',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'options', wire: 'options', source: 'json', codec: {
      mode: 'strict', typeSymbol: `${PACKAGE}#ReleaseOptions`, create: () => ({ parse: value => {
        if (value === undefined || value === null) return { force: false };
        if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid release options');
        return { force: value.force === true };
      } }) } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#ReleaseHistory`, create: () => ({ parse: validateReleaseHistory }) } };
}
