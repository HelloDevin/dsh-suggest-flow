// Host-side integration test: loads lib/index.mjs against stub @deepseek-ai/*
// packages, runs apply(), instantiates the service, and exercises generation with
// intents, the two-layer cache, manual refresh (avoid/cooldown/cap/failure),
// feedback + direction-bias hint, legacy memory seeding, and memory reset
// end-to-end.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stubRoot = new URL('../node_modules/@deepseek-ai/', import.meta.url);
mkdirSync(new URL('dsh-typert-protocol/', stubRoot), { recursive: true });
mkdirSync(new URL('dsh-home-paths/', stubRoot), { recursive: true });
writeFileSync(new URL('dsh-typert-protocol/package.json', stubRoot), JSON.stringify({ name: 'x', type: 'module', main: 'index.mjs' }));
writeFileSync(new URL('dsh-typert-protocol/index.mjs', stubRoot), 'export class TypertRemoteService { constructor(ctx, service) { this.ctx = ctx; this.service = service; } }');
writeFileSync(new URL('dsh-home-paths/package.json', stubRoot), JSON.stringify({ name: 'x', type: 'module', main: 'index.mjs' }));
writeFileSync(new URL('dsh-home-paths/index.mjs', stubRoot), `import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; export function resolveDshHome() { return globalThis.__dshStubHome ?? join(tmpdir(), 'dsh-stub-home'); }`);

process.on('exit', () => { try { rmSync(new URL('../node_modules/', import.meta.url), { recursive: true, force: true }); } catch { /* best effort */ } });

const mod = await import(new URL('../lib/index.mjs', import.meta.url));
const { parseSuggestions, parseReleases, compareVersions, validateSuggestions, REFRESH_COOLDOWN_MS, REFRESH_MAX_PER_REPLY } = await import(new URL('../lib/common.mjs', import.meta.url));
const t = (name, cond) => { if (!cond) { console.error('FAIL', name); process.exitCode = 1; } else console.log('ok', name); };

let home = join(tmpdir(), `dsh-suggest-flow-test-${process.pid}`);
rmSync(home, { recursive: true, force: true });
globalThis.__dshStubHome = home;

// --- parseSuggestions: protocol, filters, diversity ---
t('parse: objects with intents, order kept',
  JSON.stringify(parseSuggestions('[{"t":"为什么这样设计","i":"explore"},{"t":"写个脚本试试","i":"apply"}]', 3))
    === JSON.stringify([{ text: '为什么这样设计', intent: 'explore' }, { text: '写个脚本试试', intent: 'apply' }]));
t('parse: plain strings tolerated (no badge)',
  JSON.stringify(parseSuggestions('["换一种实现方式对比一下","explore其它思路"]', 2))
    === JSON.stringify([{ text: '换一种实现方式对比一下' }, { text: 'explore其它思路' }]));
t('parse: fenced JSON and prose wrapper',
  JSON.stringify(parseSuggestions('好的，以下是建议：\n```json\n["深入讲讲事件循环机制"\n]\n```', 2))
    === JSON.stringify([{ text: '深入讲讲事件循环机制' }]));
t('parse: quotes stripped, markdown emphasis stripped, spaces collapsed',
  JSON.stringify(parseSuggestions('["**能不能**展开讲讲调优技巧？","换个角度  从运维视角分析"]', 2))
    === JSON.stringify([{ text: '能不能展开讲讲调优技巧？' }, { text: '换个角度 从运维视角分析' }]));
t('parse: junk/assistant-voice dropped',
  parseSuggestions('["还有什么想问的吗","希望对你有帮助","我可以帮你写一个","作为AI我建议深入探讨这个主题的底层逻辑"]', 4).length === 0);
t('parse: user-question echo dropped, rest kept',
  JSON.stringify(parseSuggestions('["什么是闭包","闭包和作用域链有什么关系"]', 2, { latestUser: '什么是闭包？' }))
    === JSON.stringify([{ text: '闭包和作用域链有什么关系' }]));
t('parse: containment near-dup dropped (shorter fragment loses)',
  parseSuggestions('["给这个函数写一个完整的错误处理分支","写一个完整的错误处理"]', 2).length === 1);
t('parse: overlong / too short / newline / slash-command dropped',
  parseSuggestions('["' + '超'.repeat(81) + '","为什么","第一行\\n第二行不对","/clear之后发生了什么"]', 4).length === 0);
t('parse: avoid set re-filters shown texts',
  parseSuggestions('["部署到生产环境要注意什么","已经展示过的建议"]', 2, { avoid: ['已经展示过的建议'] }).length === 1);
t('parse: diversity interleave rounds across intents',
  JSON.stringify(parseSuggestions('[{"t":"探索事件循环","i":"explore"},{"t":"对比两套方案","i":"expand"},{"t":"再探一层原理","i":"explore"},{"t":"落地成脚本","i":"apply"}]', 4))
    === JSON.stringify([{ text: '探索事件循环', intent: 'explore' }, { text: '对比两套方案', intent: 'expand' }, { text: '落地成脚本', intent: 'apply' }, { text: '再探一层原理', intent: 'explore' }]));
t('parse: count capped',
  parseSuggestions('["建议一区别在哪","建议二成本如何","建议三怎么落地","建议四何时回滚","建议五谁负责"]', 3).length === 3);
t('parse: invalid intent tolerated without badge',
  JSON.stringify(parseSuggestions('[{"t":"这个异常何时会触发","i":"maybe"}]', 1)) === JSON.stringify([{ text: '这个异常何时会触发' }]));
t('parse: empty array, blank input and meta-list lines → empty',
  parseSuggestions('[]', 3).length === 0 && parseSuggestions('', 3).length === 0
  && parseSuggestions('以下是建议：\n1. 这个方案的原理是什么', 3).length === 1
  && parseSuggestions('以下是建议', 3).length === 0
  && parseSuggestions('好的，以下是建议：', 3).length === 0);

// --- validateSuggestions (RPC result codec) ---
t('codec: suggestions validate and normalize',
  JSON.stringify(validateSuggestions(['直接跑单元测试', { t: '看看边界条件', i: 'EXPLORE' }]))
    === JSON.stringify([{ text: '直接跑单元测试' }, { text: '看看边界条件', intent: 'explore' }]));
let codecThrew = false;
try { validateSuggestions([{ nonsense: true }]); } catch { codecThrew = true; }
t('codec: invalid item rejected', codecThrew);
codecThrew = false;
try { validateSuggestions(Array(5).fill('条数超限不允许')); } catch { codecThrew = true; }
t('codec: >4 items rejected', codecThrew);

// --- service-level integration ---
let llmCalls = 0;
let llmScript = [];
let lastLlmCall = null;
const llm = { stream: async function* (call) {
  llmCalls++;
  lastLlmCall = call;
  const output = llmScript.length ? llmScript.shift() : '["先跑一下测试","看看有哪些未提交的改动"]';
  yield { type: 'text-delta', index: 0, text: output };
} };
const invocations = [];
const ctx = {
  llm,
  typert: { register: info => invocations.push(...info.invocations.map(item => item.method)) },
  plugin: (cls, cfg) => { ctx.captured = { cls, cfg }; },
};
await mod.apply(ctx, { enabled: true, count: 2, STRAY_HOST_KEY: 'ignored' });
t('stray config key ignored', ctx.captured.cfg.count === 2 && !ctx.captured.cfg.STRAY_HOST_KEY);
t('eight RPCs registered', invocations.length === 8 && invocations.includes('refreshSuggestions')
  && invocations.includes('cachedSuggestions') && invocations.includes('resetMemory') && invocations.includes('releaseHistory'));

const service = new ctx.captured.cls({ llm }, { enabled: true, count: 2 });
const input = { sessionId: 's1', replyId: 'r1', provider: 'deepseek', model: 'm',
  turns: [{ user: '帮我修登录的 bug', assistant: '已修复并跑了测试。' }] };
const first = await service.recommend(input);
t('generate + parse with intents',
  llmCalls === 1 && JSON.stringify(first) === JSON.stringify([{ text: '先跑一下测试' }, { text: '看看有哪些未提交的改动' }]));
t('deepseek reasoning disabled, maxTokens scales with count',
  lastLlmCall.reasoningEffort === 'off' && lastLlmCall.maxTokens === 120 * 2 + 80);
await service.recordFeedback({ sessionId: 's1', replyId: 'r1', event: 'shown' });
await service.recordFeedback({ sessionId: 's1', replyId: 'r1', event: 'fill', text: '先跑一下测试' });
const second = await service.recommend(input);
t('cache hit without llm call', llmCalls === 1 && JSON.stringify(second) === JSON.stringify(first));
const patched = await service.applyChipSettings({ STRAY_KEY: 1, keyboard: false });
t('unknown patch keys dropped, keyboard applied', patched.keyboard === false);
const backOn = await service.applyChipSettings({ keyboard: true });
t('keyboard back on', backOn.keyboard === true);
const restored = await service.cachedSuggestions(input);
t('cache-only restore', JSON.stringify(restored) === JSON.stringify(first));
const missed = await service.cachedSuggestions({ ...input, replyId: 'rX' });
t('cache miss → empty, no llm call', missed.length === 0 && llmCalls === 1);
service.overrides = { enabled: false };
t('disabled → cache path returns empty', (await service.recommend(input)).length === 0);
let disabledThrew = false;
try { await service.refreshSuggestions(input); } catch { disabledThrew = true; }
t('disabled → refresh throws, never generates', disabledThrew && llmCalls === 1);
service.overrides = {};
t('hint mentions adopted', service.getConfig().hint.includes('最近被采纳') && service.getConfig().hint.includes('先跑一下测试'));

// --- manual refresh ---
llmScript = ['["写个部署前检查清单","换成 WebSocket 行不行","为什么选了这个方案","换个话题聊点别的"]'];
const refreshed = await service.refreshSuggestions(input);
t('refresh forces a new llm call (cache bypassed)', llmCalls === 2 && lastLlmCall !== null);
t('refresh result replaces the entry', JSON.stringify(refreshed) === JSON.stringify([
  { text: '写个部署前检查清单' }, { text: '换成 WebSocket 行不行' }]));
t('refresh user message carries the avoid list',
  lastLlmCall.messages[0].content[0].text.includes('已展示过') && lastLlmCall.messages[0].content[0].text.includes('先跑一下测试'));
let cooldownThrew = false;
try { await service.refreshSuggestions(input); } catch (error) { cooldownThrew = /too fast/i.test(error.message); }
t('refresh cooldown enforced', cooldownThrew && llmCalls === 2);
service.cache.get('s1::r1').lastRefreshAt = Date.now() - REFRESH_COOLDOWN_MS - 1;
llmScript = ['["先跑一下测试","看看有哪些未提交的改动"]']; // model returns only already-shown texts
let emptyThrew = false;
try { await service.refreshSuggestions(input); } catch (error) { emptyThrew = /No new suggestions/i.test(error.message); }
t('refresh returning only shown texts keeps the old row (throws, no replace)',
  emptyThrew && JSON.stringify(service.cache.get('s1::r1').suggestions) === JSON.stringify(refreshed));
service.cache.get('s1::r1').lastRefreshAt = Date.now() - REFRESH_COOLDOWN_MS - 1;
llmScript = [JSON.stringify([{ t: '给我一份回滚方案', i: 'apply' }, { t: '这个方案的原理是什么', i: 'explore' }])];
const refreshed2 = await service.refreshSuggestions(input);
t('second refresh replaces and keeps intents',
  JSON.stringify(refreshed2) === JSON.stringify([{ text: '这个方案的原理是什么', intent: 'explore' }, { text: '给我一份回滚方案', intent: 'apply' }]));
const entryAfter = service.cache.get('s1::r1');
t('shownHistory accumulates replaced sets',
  entryAfter.shownHistory.includes('先跑一下测试') && entryAfter.shownHistory.includes('写个部署前检查清单')
  && entryAfter.refreshCount === 2);
t('avoid list spans current set + history',
  lastLlmCall.messages[0].content[0].text.includes('换成 WebSocket 行不行') && lastLlmCall.messages[0].content[0].text.includes('写个部署前检查清单'));
service.cache.get('s1::r1').lastRefreshAt = Date.now() - REFRESH_COOLDOWN_MS - 1;
service.cache.get('s1::r1').refreshCount = REFRESH_MAX_PER_REPLY;
const llmCallsBeforeCap = llmCalls;
let capThrew = false;
try { await service.refreshSuggestions(input); } catch (error) { capThrew = /limit/i.test(error.message); }
t('refresh cap enforced', capThrew && llmCalls === llmCallsBeforeCap);
service.cache.get('s1::r1').refreshCount = 0;
llmScript = [];
let llmWasToThrow = llm.stream;
llm.stream = async function* () { llmCalls++; throw new Error('network down'); };
let failThrew = false;
try { await service.refreshSuggestions(input); } catch { failThrew = true; }
t('refresh failure keeps old suggestions (error propagates, entry untouched)',
  failThrew && JSON.stringify(service.cache.get('s1::r1').suggestions) === JSON.stringify(refreshed2));
llm.stream = llmWasToThrow;

// --- feedback → intent attribution → direction bias ---
await service.recordFeedback({ sessionId: 's1', replyId: 'r1', event: 'fill', text: '给我一份回滚方案' });
t('fill feedback attributes intent from the suggestion set',
  service.cache.get('s1::r1').items.find(item => item.text === '给我一份回滚方案')?.intent === 'apply');
t('bias hint below threshold stays quiet', !service.getConfig().hint.includes('更常采纳'));
// Simulate 3 more adopt/apply signals from other replies → bias engages.
for (let i = 0; i < 3; i++) {
  const key = `s2::r${i}`;
  service.cache.set(key, { sessionId: 's2', replyId: `r${i}`, suggestions: [{ text: `落地步骤${i}`, intent: 'apply' }],
    items: [{ text: `落地步骤${i}`, state: 'send', intent: 'apply' }, { text: `被忽略的宽泛建议${i}`, state: 'shown' }], ts: Date.now() });
}
const biased = service.getConfig().hint;
t('direction bias engages after ≥3 tagged adoptions', biased.includes('更常采纳') && biased.includes('实际应用'));
t('bias hint still lists adopted texts', biased.includes('给我一份回滚方案'));

// --- legacy memory seeding (dsh-suggestion-chips → dsh-suggest-flow) ---
const legacyDir = join(home, 'storages', 'dsh-suggestion-chips');
mkdirSync(legacyDir, { recursive: true });
writeFileSync(join(legacyDir, 'memory.json'), JSON.stringify({ entries: {
  's9::r9': { sessionId: 's9', replyId: 'r9', suggestions: ['旧插件的一条建议'],
    items: [{ text: '旧插件的一条建议', state: 'send' }], ts: Date.now() },
} }));
const ownMemoryFile = join(home, 'storages', 'dsh-suggest-flow', 'memory.json');
rmSync(ownMemoryFile, { force: true });
const seeded = new ctx.captured.cls({ llm }, { enabled: true, count: 2 });
t('legacy seed imported and coerced to object shape',
  JSON.stringify(seeded.cache.get('s9::r9')?.suggestions) === JSON.stringify([{ text: '旧插件的一条建议' }]));
t('legacy seed feeds the hint', seeded.getConfig().hint.includes('旧插件的一条建议'));
seeded.schedulePersist();
await new Promise(resolve => setTimeout(resolve, 1000));
t('seeded memory persisted to our own storage file', existsSync(ownMemoryFile)
  && Object.keys(JSON.parse(readFileSync(ownMemoryFile, 'utf8')).entries).includes('s9::r9'));

// --- resetMemory ---
await seeded.resetMemory();
t('reset clears hint and cache', seeded.getConfig().hint === '' && seeded.cache.size === 0 && !existsSync(ownMemoryFile));

// --- engine-level regression: a force call must never join an inflight job ---
// (Unreachable through the service layer — refreshSuggestions requires a cached
// entry, and entry creation follows job settlement — but the engine stands alone.)
{
  const { createRecommender } = await import(new URL('../lib/engine.mjs', import.meta.url));
  const calls = [];
  let counter = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const raceLlm = { stream: async function* () {
    const index = ++counter;
    calls.push(index);
    // Text fixed at call time, not resume time.
    const text = index === 1
      ? JSON.stringify([{ t: '自动生成的建议内容', i: 'explore' }])
      : JSON.stringify([{ t: '刷新出来的新建议', i: 'apply' }]);
    if (index === 1) await gate;
    yield { type: 'text-delta', index: 0, text };
  } };
  const raceRecommend = createRecommender(raceLlm, () => ({ enabled: true, count: 2, timeoutMs: 20000 }));
  const raceInput = { sessionId: 'sx', replyId: 'rx', provider: 'deepseek', model: 'm', turns: [{ user: 'u', assistant: 'a' }] };
  const pending = raceRecommend(raceInput);
  await new Promise(resolve => setImmediate(resolve));
  const forced = await raceRecommend(raceInput, undefined, { force: true, avoid: ['已经展示过的旧建议'] });
  release();
  const auto = await pending;
  t('force refresh does not join inflight auto job (own call + avoid)',
    calls.length === 2 && JSON.stringify(forced) === JSON.stringify([{ text: '刷新出来的新建议', intent: 'apply' }])
    && JSON.stringify(auto) === JSON.stringify([{ text: '自动生成的建议内容', intent: 'explore' }]));
}

// --- release history: sanitizer, version compare, and the TTL-cached host RPC ---
t('parseReleases drops drafts/prerelease/bad tags, sorts desc, dedupes',
  JSON.stringify(parseReleases([
    { tag_name: '0.6.0', published_at: '2026-11-22T09:00:00Z', prerelease: true },
    { tag_name: 'v0.5.0', published_at: '2026-11-20T10:00:00Z' },
    { tag_name: '0.4.10', published_at: '2026-11-21T08:00:00Z', draft: true },
    { tag_name: 'not-a-version', published_at: '2026-11-21T08:00:00Z' },
    { tag_name: ' v0.4.9 ', published_at: '2026-11-21T07:00:00Z' },
    { tag_name: 'v0.4.9', published_at: '2026-11-21T06:00:00Z' },
  ])) === JSON.stringify([{ version: '0.5.0', date: '2026-11-20' }, { version: '0.4.9', date: '2026-11-21' }]));
t('compareVersions', compareVersions('0.10.0', '0.9.9') === 1 && compareVersions('1.0.0', '1.0.0') === 0
  && compareVersions('0.4.9', '0.4.10') === -1);
const realFetch = globalThis.fetch;
let releaseFetches = 0;
globalThis.fetch = async () => {
  releaseFetches++;
  return { ok: true, status: 200, json: async () => [
    { tag_name: 'v9.9.9', published_at: '2026-11-22T00:00:00Z' },
    { tag_name: 'v0.4.9', published_at: '2026-11-21T00:00:00Z' },
  ] };
};
const releases1 = await service.releaseHistory({}, undefined);
const releases2 = await service.releaseHistory({}, undefined);
t('releaseHistory fetches once then serves TTL cache', releaseFetches === 1
  && releases1.releases[0].version === '9.9.9' && releases2.checkedAt === releases1.checkedAt);
const forced = await service.releaseHistory({ force: true }, undefined);
t('releaseHistory force bypasses cache', releaseFetches === 2 && forced.checkedAt >= releases1.checkedAt);
globalThis.fetch = realFetch;

rmSync(home, { recursive: true, force: true });
if (process.exitCode) console.error('HOST TEST FAILED');
else console.log('HOST TEST OK');
