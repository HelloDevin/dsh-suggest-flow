const { createElement: h, useEffect, useLayoutEffect, useRef, useState } = require('react');

const NS = 'suggest-flow';
// Version-list presentation cap: the parsed history stays ≤20 on the host, the
// section shows only the newest few so the card stays compact.
const MAX_VERSION_ROWS = 5;
// Soft client-side mirror of the host refresh cooldown: the button re-arms on the
// same schedule after each attempt (success or failure). The host stays
// authoritative — a rejected refresh just keeps the old suggestions.
const CLIENT_REFRESH_COOLDOWN_MS = 6000;
const DICTIONARIES = {
  zh: {
    'settings.nav': '智能追问',
    'settings.title': '智能追问 Suggest Flow',
    'settings.subtitle': 'AI 回复后在输入框上方给出 Explore / Expand / Apply 三向智能追问：单击填入，双击直接发送，可一键换一组。',
    'settings.enabled': '启用智能追问',
    'settings.doubleClickSend': '双击直接发送',
    'settings.hideWhenTyping': '开始打字时隐藏建议',
    'settings.keyboard': '键盘快捷键（↑ 激活、←→ 选择、Enter 填入、Ctrl+Enter 发送）',
    'settings.count': '每轮建议条数上限',
    'settings.countDesc': '模型按对话动态给出 0~N 条，N 只是上限；宁缺毋滥',
    'settings.group.behavior': '建议行为',
    'settings.group.interaction': '交互',
    'settings.group.data': '本地数据',
    'settings.group.update': '版本',
    'dir.explore': '深入探索',
    'dir.expand': '横向扩展',
    'dir.apply': '实际应用',
    'chips.refresh': '换一组建议',
    'settings.versions.check': '重新检查',
    'settings.versions.checking': '正在检查更新…',
    'settings.versions.failed': '检查失败（网络）',
    'settings.versions.retry': '重试',
    'settings.versions.available': '可更新到 {v}',
    'settings.versions.published': '发布于 {d}',
    'settings.versions.latest': 'latest',
    'settings.versions.installed': '已安装',
    'settings.versions.uptodate': '已是最新版本',
    'settings.versions.checkedAt': '检查于 {t}',
    'settings.versions.expand': '展开',
    'settings.versions.collapse': '收起',
    'settings.update.button': '更新',
    'settings.update.updating': '正在更新…',
    'settings.update.done': '更新完成，重启 DSH 生效',
    'settings.update.failed': '更新失败',
    'settings.update.archiveHint': '当前版本是从 GitHub 安装包链接安装的，市场按名更新不适用。请重跑安装命令更新（见 README「安装」；命令永远指向最新版），或先卸载再从插件市场安装。',
    'settings.resetMemoryDesc': '删除本机记录的采纳历史与建议缓存（保留 30 天）',
    'settings.resetMemory': '清空采纳记忆与建议缓存',
    'settings.resetMemoryShort': '清空',
    'settings.memoryCleared': '已清空',
    'settings.loading': '正在读取设置…',
    'settings.saved': '已保存',
    'settings.saveFailed': '保存失败，请重试',
  },
  en: {
    'settings.nav': 'Suggest Flow',
    'settings.title': 'Suggest Flow',
    'settings.subtitle': 'Smart follow-ups above the composer after each reply: Explore / Expand / Apply chips — click to fill, double-click to send, one-click refresh.',
    'settings.enabled': 'Enable Suggest Flow',
    'settings.doubleClickSend': 'Send on double-click',
    'settings.hideWhenTyping': 'Hide suggestions while typing',
    'settings.keyboard': 'Keyboard shortcuts (↑ activate, ←→ move, Enter fill, Ctrl+Enter send)',
    'settings.count': 'Suggestions per turn (cap)',
    'settings.countDesc': 'The model adaptively returns 0–N; N is only an upper bound',
    'settings.group.behavior': 'Suggestions',
    'settings.group.interaction': 'Interaction',
    'settings.group.data': 'Local data',
    'settings.group.update': 'Version',
    'dir.explore': 'Explore',
    'dir.expand': 'Expand',
    'dir.apply': 'Apply',
    'chips.refresh': 'Refresh suggestions',
    'settings.versions.check': 'Recheck',
    'settings.versions.checking': 'Checking for updates…',
    'settings.versions.failed': 'Check failed (network)',
    'settings.versions.retry': 'Retry',
    'settings.versions.available': 'Update to {v} available',
    'settings.versions.published': 'Published {d}',
    'settings.versions.latest': 'latest',
    'settings.versions.installed': 'installed',
    'settings.versions.uptodate': 'Up to date',
    'settings.versions.checkedAt': 'Checked at {t}',
    'settings.versions.expand': 'Expand',
    'settings.versions.collapse': 'Collapse',
    'settings.update.button': 'Update',
    'settings.update.updating': 'Updating…',
    'settings.update.done': 'Updated — restart DSH to apply',
    'settings.update.failed': 'Update failed',
    'settings.update.archiveHint': 'This copy was installed from a GitHub release archive link, so the market cannot update it by name. Re-run the install command (README「Install」; it always points to the latest release), or uninstall first and install from the plugin market.',
    'settings.resetMemoryDesc': 'Deletes the locally stored adoption history and suggestion cache (30-day window)',
    'settings.resetMemory': 'Clear adoption memory & cache',
    'settings.resetMemoryShort': 'Clear',
    'settings.memoryCleared': 'Cleared',
    'settings.loading': 'Loading settings…',
    'settings.saved': 'Saved',
    'settings.saveFailed': 'Save failed, please retry',
  },
};
const FALLBACK = DICTIONARIES.zh;

const STYLE_TAG_ID = 'dsh-suggest-flow-style';
let styleUsers = 0;

// Dock geometry mirrors the host's own dock entries: match the composer card width,
// wrap instead of scrolling, and stay opaque so transcript content never shows through.
const CSS_TEXT = `
.dsh-suggest-flow-dock {
  box-sizing: border-box;
  flex: none;
  max-width: 100%;
  margin: 0 auto;
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  pointer-events: none;
  margin-bottom: calc(-1 * var(--dsh-composer-stack-gap, 6px));
  transition: grid-template-rows .22s ease, opacity .18s ease, margin-bottom .22s ease;
}
.dsh-suggest-flow-dock.is-open {
  grid-template-rows: 1fr;
  opacity: 1;
  pointer-events: auto;
  margin-bottom: 0;
}
/* Send-moment exit: fade only, keep the height, snap closed while invisible. */
.dsh-suggest-flow-dock.is-fading {
  opacity: 0;
  pointer-events: none;
  transition: opacity .18s ease;
}
.dsh-suggest-flow-dock.no-anim {
  transition: none !important;
}
.dsh-suggest-flow-collapse {
  overflow: hidden;
  min-height: 0;
}
.dsh-suggest-flow-row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 3px 0 3px 2px;
  background: var(--dsw-alias-bg-base, #fff);
  border-radius: 6px 6px 0 0;
}
/* Chips wrap inside the remaining space; the refresh button stays pinned at the
   right edge and never drops to its own line. */
.dsh-suggest-flow-chips {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.dsh-suggest-flow-bubble {
  box-sizing: border-box;
  flex: none;
  max-width: 100%;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border: 1px solid var(--dsw-alias-border-l1, #d8dce2);
  border-radius: 13px;
  background: var(--dsw-specific-tip, rgba(127, 136, 153, 0.12));
  color: var(--dsw-alias-label-primary, #23262d);
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  text-align: left;
  transform-origin: 0% 100%;
  /* Staggered entry: rise from the lower corner first, fade in just after. */
  animation: dsh-suggest-flow-in .48s cubic-bezier(.215, .61, .355, 1) both;
  transition: background-color .15s ease-out, border-color .15s ease-out;
}
.dsh-suggest-flow-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Direction badge: one quiet dot per intent, theme-aware for explore. */
.dsh-suggest-flow-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  margin-right: 7px;
  background: var(--dsw-alias-border-l2, #c9ced6);
}
.dsh-suggest-flow-dot.is-explore { background: var(--dsw-alias-state-business-primary, #2f6fed); }
.dsh-suggest-flow-dot.is-expand { background: #8b5cf6; }
.dsh-suggest-flow-dot.is-apply { background: #22a06b; }
/* Manual refresh: a quiet SVG icon button pinned at the row's right edge. */
.dsh-suggest-flow-refresh {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  margin-left: 2px;
  border: 1px solid var(--dsw-alias-border-l1, #d8dce2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-secondary, #5c6470);
  cursor: pointer;
  transition: background-color .15s ease-out, border-color .15s ease-out, color .15s ease-out;
}
.dsh-suggest-flow-refresh:hover {
  border-color: var(--dsw-alias-state-business-primary, #2f6fed);
  background: var(--dsw-alias-interactive-bg-hover, rgba(47, 111, 237, 0.12));
  color: var(--dsw-alias-state-business-primary, #2f6fed);
}
.dsh-suggest-flow-refresh:disabled { opacity: .45; cursor: default; }
.dsh-suggest-flow-glyph { display: inline-flex; transform-origin: 50% 50%; }
.dsh-suggest-flow-refresh.is-spinning .dsh-suggest-flow-glyph { animation: dsh-suggest-flow-spin .9s linear infinite; }
@keyframes dsh-suggest-flow-spin { to { transform: rotate(360deg); } }
@keyframes dsh-suggest-flow-in {
  0% { opacity: 0; transform: translateY(10px) scale(.94); }
  20% { opacity: 0; transform: translateY(7px) scale(.95); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-suggest-flow-bubble { animation: none; }
  .dsh-suggest-flow-refresh.is-spinning .dsh-suggest-flow-glyph { animation: none; }
}
.dsh-suggest-flow-bubble:focus,
.dsh-suggest-flow-bubble:focus-visible { outline: none; }
.dsh-suggest-flow-bubble:hover {
  border-color: var(--dsw-alias-state-business-primary, #2f6fed);
  background: var(--dsw-alias-interactive-bg-hover, rgba(47, 111, 237, 0.12));
}
.dsh-suggest-flow-bubble.is-kbd {
  border-color: var(--dsw-alias-state-business-primary, #2f6fed);
  background: var(--dsw-alias-interactive-bg-hover, rgba(47, 111, 237, 0.12));
}
/* Settings UI: card rows + iOS-style switches, themed via dsw alias vars. */
.dsh-suggest-flow-head { display: flex; align-items: center; gap: 12px; margin: 4px 0 14px; }
.dsh-suggest-flow-head-icon {
  width: 40px; height: 40px; flex: none; border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2f6fed) 12%, transparent);
  display: flex; align-items: center; justify-content: center; font-size: 19px;
}
.dsh-suggest-flow-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #23262d); }
.dsh-suggest-flow-subtitle { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #5c6470); margin-top: 2px; }
.dsh-suggest-flow-group { font-size: 12px; color: var(--dsw-alias-label-tertiary, #68707d); margin: 16px 2px 6px; }
.dsh-suggest-flow-card {
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l1, #e2e5ea);
  border-radius: 12px; overflow: hidden;
}
.dsh-suggest-flow-setrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; }
.dsh-suggest-flow-card .dsh-suggest-flow-setrow + .dsh-suggest-flow-setrow { border-top: 1px solid color-mix(in srgb, currentColor 7%, transparent); }
label.dsh-suggest-flow-setrow { cursor: pointer; }
.dsh-suggest-flow-rowlabel { font-size: 13px; color: var(--dsw-alias-label-primary, #23262d); }
.dsh-suggest-flow-rowdesc { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #68707d); margin-top: 2px; }
.dsh-suggest-flow-switch { position: relative; display: inline-block; width: 38px; height: 21px; flex: none; }
.dsh-suggest-flow-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.dsh-suggest-flow-track { position: absolute; inset: 0; border-radius: 999px; background: var(--dsw-alias-border-l2, #c9ced6); transition: background .18s ease; }
.dsh-suggest-flow-track::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px;
  border-radius: 999px; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .25);
  transition: transform .18s ease;
}
.dsh-suggest-flow-switch input:checked ~ .dsh-suggest-flow-track { background: var(--dsw-alias-state-business-primary, #2f6fed); }
.dsh-suggest-flow-switch input:checked ~ .dsh-suggest-flow-track::after { transform: translateX(17px); }
.dsh-suggest-flow-switch input:disabled ~ .dsh-suggest-flow-track { opacity: .45; }
.dsh-suggest-flow-select {
  color: var(--dsw-alias-label-primary, #23262d); background: transparent;
  border: 1px solid var(--dsw-alias-border-l1, #d8dce2); border-radius: 8px;
  padding: 4px 8px; font-size: 13px;
}
.dsh-suggest-flow-ghostbtn {
  color: var(--dsw-alias-label-primary, #23262d); background: transparent;
  border: 1px solid var(--dsw-alias-border-l1, #d8dce2); border-radius: 8px;
  padding: 5px 12px; font-size: 12.5px; cursor: pointer;
}
.dsh-suggest-flow-ghostbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(47, 111, 237, .08)); }
.dsh-suggest-flow-ghostbtn:disabled { opacity: .5; cursor: default; }
.dsh-suggest-flow-msg { margin: 10px 2px 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #5c6470); }
/* 版本 section: native-style headline card + per-version rows. */
.dsh-suggest-flow-verhead { display: flex; align-items: center; gap: 10px; padding: 12px 14px; }
.dsh-suggest-flow-verhead-icon {
  width: 32px; height: 32px; flex: none; border-radius: 8px; font-size: 15px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2f6fed) 10%, transparent);
  display: flex; align-items: center; justify-content: center;
}
.dsh-suggest-flow-vertitle { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #23262d); }
.dsh-suggest-flow-verdate { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #68707d); margin-top: 2px; }
.dsh-suggest-flow-verrow { display: flex; align-items: center; gap: 8px; padding: 9px 14px; }
.dsh-suggest-flow-vernum { font-size: 13px; color: var(--dsw-alias-label-primary, #23262d); }
.dsh-suggest-flow-pill {
  flex: none; font-size: 10.5px; line-height: 16px; padding: 0 7px; border-radius: 999px;
  background: color-mix(in srgb, currentColor 8%, transparent); color: var(--dsw-alias-label-tertiary, #68707d);
}
.dsh-suggest-flow-vertime { margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #68707d); }
.dsh-suggest-flow-verfoot { display: flex; padding: 8px 14px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #68707d); }
.dsh-suggest-flow-card > .dsh-suggest-flow-verrow + .dsh-suggest-flow-verrow,
.dsh-suggest-flow-card > .dsh-suggest-flow-verrow + .dsh-suggest-flow-verfoot,
.dsh-suggest-flow-card > .dsh-suggest-flow-verhead + .dsh-suggest-flow-verrow,
.dsh-suggest-flow-card > .dsh-suggest-flow-verhead + .dsh-suggest-flow-verfoot {
  border-top: 1px solid color-mix(in srgb, currentColor 7%, transparent);
}
.dsh-suggest-flow-linkbtn {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px;
  background: transparent; border: none; cursor: pointer; font-size: 12px;
  color: var(--dsw-alias-label-secondary, #5c6470);
}
.dsh-suggest-flow-linkbtn:hover { color: var(--dsw-alias-state-business-primary, #2f6fed); }
.dsh-suggest-flow-linkbtn:disabled { opacity: .5; cursor: default; }
`;

// 2D chip navigation: chips are grouped into rows by their rendered position;
// ←→ move within the row (wrapping at both ends), ↑↓ jump to the nearest chip in
// the row above/below (wrapping top↔bottom for a single row).
function moveChipSelection(index, key, container) {
  const chips = container ? Array.from(container.querySelectorAll('.dsh-suggest-flow-bubble')) : [];
  const n = chips.length;
  if (!n) return index;
  if (key === 'ArrowLeft') return (index - 1 + n) % n;
  if (key === 'ArrowRight') return (index + 1) % n;
  const rects = chips.map(node => node.getBoundingClientRect());
  const centerX = i => rects[i].left + rects[i].width / 2;
  const centerY = i => rects[i].top + rects[i].height / 2;
  const rows = [];
  rects.forEach((_, i) => {
    const row = rows.find(list => Math.abs(centerY(list[0]) - centerY(i)) <= rects[i].height / 2 + 2);
    if (row) row.push(i); else rows.push([i]);
  });
  rows.sort((a, b) => centerY(a[0]) - centerY(b[0]));
  const rowIndex = Math.max(0, rows.findIndex(list => list.includes(index)));
  const step = key === 'ArrowDown' ? 1 : -1;
  const targetRow = rows[(rowIndex + step + rows.length) % rows.length];
  if (!targetRow || targetRow === rows[rowIndex]) return step === 1 ? 0 : n - 1;
  let best = targetRow[0], bestDist = Infinity;
  for (const i of targetRow) {
    const dist = Math.abs(centerX(i) - centerX(index));
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

function useComputedStyleTag() {
  useEffect(() => {
    styleUsers += 1;
    if (document.getElementById(STYLE_TAG_ID) === null) {
      const tag = document.createElement('style');
      tag.id = STYLE_TAG_ID;
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
    }
    return () => {
      styleUsers -= 1;
      if (styleUsers !== 0) return;
      document.getElementById(STYLE_TAG_ID)?.remove();
    };
  }, []);
}

function dirLabel(intent, tr) {
  return intent && INTENTS.includes(intent) ? tr(`dir.${intent}`) : '';
}

function ChipsRow({ sessionId, useInput, useSession, useConversation, useProjection, inputActions, generate, restoreOrGenerate, refresh, remote, t }) {
  const tr = typeof t === 'function' ? t : (key => FALLBACK[key] ?? key);
  // Props presence is fixed per mount, so guarded hook calls keep a stable order.
  const input = useInput(value => value);
  const running = useSession ? useSession(value => value.running) : false;
  const removed = useSession ? useSession(value => value.removed) : false;
  const selectedModel = useProjection ? useProjection('modelSelection', value => value?.next ?? value?.lastUsed) : undefined;
  const [suggestions, setSuggestions] = useState([]);
  const [resultKey, setResultKey] = useState(null);
  // Bumped whenever the row content changes while visible (refresh), so chips
  // re-key and the entry animation replays for the new set.
  const [revision, setRevision] = useState(0);
  const [doubleClickSend, setDoubleClickSend] = useState(true);
  const [hideWhenTyping, setHideWhenTyping] = useState(true);
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);
  const [kbdIndex, setKbdIndex] = useState(-1);
  const [contextTurns, setContextTurns] = useState(3);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshGated, setRefreshGated] = useState(false);
  const candidate = useConversation(value => selectContext(value.views.get('chat')?.legacy.nodes ?? [], sessionId, selectedModel, contextTurns),
    (a, b) => a?.replyId === b?.replyId && JSON.stringify(a?.turns) === JSON.stringify(b?.turns)
      && a?.provider === b?.provider && a?.model === b?.model);
  const turnsSignature = candidate ? JSON.stringify(candidate.turns) : '';
  const replyKey = candidate ? JSON.stringify([sessionId, candidate.replyId, candidate.provider, candidate.model]) : null;
  const [cardWidth, setCardWidth] = useState(0);
  const dockRef = useRef(null);
  const request = useRef(null);
  const refreshAbort = useRef(null);
  const refreshTimer = useRef(null);
  const filledRef = useRef(null);
  const impressionRef = useRef(null);
  const generatedRef = useRef(null); // last (session, reply, turns) we ran a model call for
  const holdTimer = useRef(null);
  const heldRef = useRef(null);
  const contentRef = useRef(null);
  // The last running-flag we saw for the CURRENT session id. The composer is a
  // resident component (it survives session switches and restarts re-hydrate old
  // transcripts progressively), so "is this a new turn" is decided by watching the
  // running flag go true→false — never by diffing transcript content, which moves
  // while old sessions hydrate.
  const wasRunningRef = useRef(null);

  // Settings can change on the settings page while sessions stay open; re-read once
  // per turn so the next round of chips follows without a restart.
  useEffect(() => {
    let disposed = false;
    remote.chipSettings().then(result => {
      if (disposed || !result.ok || !result.value) return;
      if (typeof result.value.doubleClickSend === 'boolean') setDoubleClickSend(result.value.doubleClickSend);
      if (typeof result.value.hideWhenTyping === 'boolean') setHideWhenTyping(result.value.hideWhenTyping);
      if (typeof result.value.keyboard === 'boolean') setKeyboardEnabled(result.value.keyboard);
      if (Number.isInteger(result.value.contextTurns)) setContextTurns(result.value.contextTurns);
    }).catch(() => { /* Keep the documented defaults. */ });
    return () => { disposed = true; };
  }, [remote, replyKey]);

  const idle = !running && !removed && input.phase === 'plain';
  // Filling via a chip is not "typing": while the draft still holds the text a chip
  // just wrote, the row stays up so the double-click lands on a mounted button.
  const unobstructed = !hideWhenTyping || input.draft === '' || input.draft === filledRef.current;

  // Reset whenever the turn state moves; generate for the current reply when idle.
  // The signature guard is a no-op under real React (the dep array already gates
  // it) and keeps effect-once semantics under effect-rerun test doubles.
  const turnSigRef = useRef('');
  useEffect(() => {
    const signature = JSON.stringify([sessionId, replyKey, turnsSignature, running, removed, idle]);
    if (turnSigRef.current === signature) return;
    turnSigRef.current = signature;
    setSuggestions([]); setResultKey(null); setKbdIndex(-1);
    // Fresh = the turn finished while we watched (running true→false for THIS
    // session). Reopening a session never observes that transition, so old replies
    // are cache-only — no model call, even while the transcript hydrates and its
    // content signature moves. Generation failures are silent: no retry UI, the
    // next ended turn simply tries again.
    const seen = wasRunningRef.current && wasRunningRef.current.sessionId === sessionId
      ? wasRunningRef.current.running : false;
    const endedHere = seen === true && running === false;
    wasRunningRef.current = { sessionId, running: Boolean(running) };
    const alive = Boolean(candidate) && !running && !removed;
    if (!alive) return;
    const controller = new AbortController();
    const job = { controller, candidate, replyKey };
    request.current = job;
    const cleanup = () => { controller.abort(); if (request.current === job) request.current = null; };
    if (!idle) return cleanup;
    // An ended turn we already generated for (transcript edits, session round-trips)
    // is served from cache — identical context must not re-cost a model call.
    const alreadyGenerated = generatedRef.current && generatedRef.current.sessionId === sessionId
      && generatedRef.current.replyId === candidate.replyId && generatedRef.current.turns === turnsSignature;
    const fetchImpl = endedHere && !alreadyGenerated ? generate : restoreOrGenerate;
    fetchImpl(job.candidate, job.controller.signal).then(list => {
      if (!job.controller.signal.aborted && request.current === job) {
        if (fetchImpl === generate) generatedRef.current = { sessionId, replyId: candidate.replyId, turns: turnsSignature };
        setSuggestions(Array.isArray(list) ? list : []);
        setResultKey(job.replyKey);
      }
    }).catch(error => {
      console.warn('[suggest-flow] Suggestion unavailable:', error?.message ?? 'unknown error');
    });
    return cleanup;
  }, [sessionId, replyKey, turnsSignature, running, removed, generate, restoreOrGenerate, idle]);

  // Manual refresh lifecycle: abort an in-flight refresh when the session/turn
  // moves or the row unmounts, and stop the cooldown timer cleanly.
  const refreshScopeRef = useRef('');
  useEffect(() => () => {
    refreshAbort.current?.abort();
    if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
  }, []);
  useEffect(() => {
    const signature = `${sessionId}|${replyKey}`;
    if (refreshScopeRef.current === signature) return;
    refreshScopeRef.current = signature;
    refreshAbort.current?.abort();
    setRefreshing(false);
    setRefreshGated(false);
    if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
  }, [sessionId, replyKey]);

  useComputedStyleTag();

  // Clicking fills the draft at once (replaces it); a second click on the same chip
  // within the double-tap window sends — a pattern which never depends on
  // the browser's dblclick event surviving the first click's re-render.
  const fill = text => {
    filledRef.current = text;
    try { inputActions.setDraft(text); } catch (error) {
      console.warn('[suggest-flow] Draft fill unavailable:', error?.message ?? 'unknown error');
    }
  };
  const send = () => {
    if (typeof inputActions.submit !== 'function') return;
    try { inputActions.submit(); } catch (error) {
      console.warn('[suggest-flow] Submit unavailable:', error?.message ?? 'unknown error');
    }
  };
  const lastClickRef = useRef(null);
  // Best-effort local feedback: the host folds these into future suggestion prompts.
  const record = (event, text) => {
    try {
      if (!candidate) return;
      const p = remote.recordFeedback({ sessionId, replyId: candidate.replyId, event, ...(text ? { text } : {}) });
      p?.catch?.(() => {});
    } catch { /* feedback is optional */ }
  };
  const onChipClick = (text, index) => {
    // Mouse picks move the keyboard highlight too, so ←→ continue from the click.
    setKbdIndex(index);
    const now = Date.now();
    const last = lastClickRef.current;
    if (last && last.text === text && now - last.at <= 300) {
      lastClickRef.current = null;
      fill(text);
      if (doubleClickSend) { record('send', text); send(); } else record('fill', text);
    } else {
      lastClickRef.current = { text, at: now };
      fill(text);
      record('fill', text);
    }
  };
  // One-click refresh: ask the host for a fresh set that avoids everything shown
  // in this reply. Success swaps the row (old texts move to the host's avoid
  // history); any failure keeps the current suggestions untouched.
  const onRefresh = () => {
    if (refreshing || refreshGated || !candidate || typeof refresh !== 'function') return;
    refreshAbort.current?.abort();
    const controller = new AbortController();
    refreshAbort.current = controller;
    setRefreshing(true);
    setKbdIndex(-1);
    lastClickRef.current = null;
    refresh(candidate, controller.signal).then(list => {
      if (controller.signal.aborted) return;
      if (Array.isArray(list) && list.length) {
        setSuggestions(list);
        setResultKey(replyKey);
        setRevision(value => value + 1);
      }
    }).catch(error => {
      if (controller.signal.aborted) return;
      console.warn('[suggest-flow] Refresh unavailable:', error?.message ?? 'unknown error');
    }).finally(() => {
      if (controller.signal.aborted) return;
      setRefreshing(false);
      setRefreshGated(true);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => { refreshTimer.current = null; setRefreshGated(false); }, CLIENT_REFRESH_COOLDOWN_MS);
    });
  };

  const showRow = resultKey === replyKey && idle && unobstructed && suggestions.length > 0;

  // Content snapshot held across the exit transition: the row fades out with its
  // chips still inside instead of popping empty. The dock stays mounted and the
  // open/closed states animate via CSS (grid rows + opacity).
  // No loading placeholder: the row only appears once the chips exist.
  const contentKey = showRow ? `c:${replyKey}:${suggestions.length}` : '';
  contentRef.current = showRow ? { kind: 'chips', items: suggestions, replyKey, revision } : null;
  const [held, setHeld] = useState(null);
  const [fading, setFading] = useState(false);
  const [noAnim, setNoAnim] = useState(false);
  const setHeldBoth = value => { heldRef.current = value; setHeld(value); };
  const heldSigRef = useRef('');
  useEffect(() => {
    const signature = JSON.stringify([contentKey, suggestions]);
    if (heldSigRef.current === signature) return;
    heldSigRef.current = signature;
    if (contentKey) {
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      setFading(false); setNoAnim(false);
      setHeldBoth(contentRef.current);
      if (contentKey.startsWith('c:') && impressionRef.current !== replyKey) {
        impressionRef.current = replyKey;
        record('shown');
      }
    } else if (heldRef.current !== null && holdTimer.current === null) {
      // Every exit is fade-only: keep the height while fading (submit clears the
      // draft BEFORE the running flag flips, so exit reasons cannot be told apart
      // reliably), then reclaim the space with transitions disabled — no visible
      // intermediate frames.
      setFading(true);
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        setNoAnim(true); setHeldBoth(null);
        holdTimer.current = setTimeout(() => { holdTimer.current = null; setNoAnim(false); setFading(false); }, 60);
      }, 180);
    }
    // `suggestions` is a deliberate extra dep: a refresh swaps content in place
    // (same replyKey, often the same length), and the held snapshot must follow.
  }, [contentKey, suggestions]);
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);

  // Keyboard navigation: ↑ activates chip selection from the composer OR from an
  // unfocused page (but never while typing in another field or a popup menu),
  // ←→ move, Enter fills, Ctrl/Cmd+Enter sends, Esc/typing/↓ exits. Native ↑
  // behavior elsewhere is untouched.
  useEffect(() => {
    const onKey = event => {
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Accept keys from the composer, our own dock (mouse-picked chips keep DOM
      // focus), or the unfocused page — everything else (menus, other fields) is
      // left alone.
      const inOurs = !!target.closest('[data-composer-card]')
        || !!target.closest('[data-suggest-flow-dock]');
      const onBody = target === document.body || target === document.documentElement;
      if (!inOurs && !onBody) return;
      if (target.matches('input, textarea, select')) return;
      const canNavigate = keyboardEnabled && showRow && suggestions.length > 0;
      const active = kbdIndex >= 0 && kbdIndex < suggestions.length;
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && active) {
        event.preventDefault(); event.stopImmediatePropagation();
        const text = suggestions[kbdIndex]?.text;
        if (input.draft !== text) fill(text);
        record('send', text); send();
        setKbdIndex(-1);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!canNavigate) { if (active) setKbdIndex(-1); return; }
      if (event.key === 'ArrowUp' && !active) {
        event.preventDefault(); event.stopImmediatePropagation();
        setKbdIndex(0);
        return;
      }
      if (!active) return;
      switch (event.key) {
        case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
          event.preventDefault(); event.stopImmediatePropagation();
          setKbdIndex(i => moveChipSelection(i, event.key, dockRef.current));
          break;
        }
        case 'Enter': {
          const text = suggestions[kbdIndex]?.text;
          if (input.draft !== '' && input.draft !== text) {
            // The user typed their own content — DSH's native Enter must send it
            // untouched. Exit selection mode and do not intercept.
            setKbdIndex(-1);
            return;
          }
          event.preventDefault(); event.stopImmediatePropagation();
          if (input.draft === text) {
            // The highlighted chip is already what the draft holds (filled earlier
            // by click or keyboard) → confirm-send it.
            setKbdIndex(-1); record('send', text); send();
          } else {
            fill(text); record('fill', text);
          }
          break;
        }
        case 'Escape': event.preventDefault(); event.stopImmediatePropagation(); setKbdIndex(-1); break;
        default: if (event.key.length === 1) setKbdIndex(-1); break;
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });
  const dockClass = 'dsh-suggest-flow-dock'
    + ((contentKey || fading) ? ' is-open' : '')
    + (fading ? ' is-fading' : '')
    + (noAnim ? ' no-anim' : '');

  // Align the row with the composer card by measuring it — theme CSS vars for dock
  // insets are not guaranteed across versions, so no calc() shortcut.
  useLayoutEffect(() => {
    const node = dockRef.current;
    if (!node) return;
    const container = node.parentElement;
    const card = container?.querySelector('[data-composer-card]') ?? document.querySelector('[data-composer-card]');
    if (!card) return;
    const measure = () => {
      const width = card.getBoundingClientRect().width;
      if (width > 0) setCardWidth(old => Math.abs(old - width) < 1 ? old : Math.round(width));
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(card);
    window.addEventListener('resize', measure);
    return () => { resize.disconnect(); window.removeEventListener('resize', measure); };
  }, [sessionId]);

  return h('div', { style: { display: 'contents' } },
    h('div', {
      ref: dockRef, className: dockClass,
      'data-suggest-flow-dock': '', style: cardWidth > 0 ? { width: cardWidth } : undefined,
    },
      h('div', { className: 'dsh-suggest-flow-collapse' },
        held ? h('div', {
          className: 'dsh-suggest-flow-row', role: 'toolbar', 'aria-label': tr('settings.nav'),
        },
          h('div', { className: 'dsh-suggest-flow-chips', role: 'group', 'aria-label': tr('settings.nav') },
            held.items.map((item, index) => {
              const text = item.text;
              const label = dirLabel(item.intent, tr);
              return h('button', {
                key: `${held.replyKey}:${held.revision}:${index}`, type: 'button',
                className: 'dsh-suggest-flow-bubble' + (keyboardEnabled && kbdIndex === index ? ' is-kbd' : ''),
                title: text,
                style: { animationDelay: `${100 + index * 110}ms` },
                onClick: () => onChipClick(text, index),
              },
                label ? h('span', {
                  className: `dsh-suggest-flow-dot is-${item.intent}`,
                  title: label, 'aria-hidden': 'true',
                }) : null,
                h('span', { className: 'dsh-suggest-flow-text' }, text));
            })),
          // Refresh icon (Feather-style rotate-cw arc): crisp at 14px, and the
          // centered glyph makes the spin read as a clean rotation.
          h('button', {
            type: 'button',
            className: 'dsh-suggest-flow-refresh' + (refreshing ? ' is-spinning' : ''),
            disabled: refreshing || refreshGated,
            title: tr('chips.refresh'), 'aria-label': tr('chips.refresh'),
            onClick: onRefresh,
          }, h('span', { className: 'dsh-suggest-flow-glyph', 'aria-hidden': 'true' },
            h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
              stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('polyline', { points: '23 4 23 10 17 10' }),
              h('path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }))))) : null)));
}

function SettingsSwitch({ checked, busy, onChange }) {
  return h('span', { className: 'dsh-suggest-flow-switch' },
    h('input', { type: 'checkbox', checked, disabled: busy, onChange: event => onChange(event.target.checked) }),
    h('span', { className: 'dsh-suggest-flow-track' }));
}

function SettingsSection({ t, remote }) {
  const tr = typeof t === 'function' ? t : (key => FALLBACK[key] ?? key);
  useComputedStyleTag(); // Settings can be opened with no conversation mounted — inject our own stylesheet.
  const [config, setLocal] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [releaseInfo, setReleaseInfo] = useState(null); // { list, checkedAt }
  const [checkState, setCheckState] = useState('loading'); // loading | ready | failed
  const [expanded, setExpanded] = useState(true);
  const [updateInfo, setUpdateInfo] = useState(null); // { phase: 'updating' | 'updated' | 'failed', message }
  const checkSeq = useRef(0);
  useEffect(() => {
    let disposed = false;
    remote.chipSettings().then(result => {
      if (!disposed && result.ok) setLocal(result.value);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [remote]);
  const update = patch => {
    const previous = config;
    setLocal(old => ({ ...(old ?? {}), ...patch }));
    setBusy(true); setMessage('');
    remote.applyChipSettings(patch).then(result => {
      if (result.ok) { setLocal(result.value); setMessage(tr('settings.saved')); }
      else { setLocal(previous); setMessage(result.error?.message ?? tr('settings.saveFailed')); }
    }).catch(error => { setLocal(previous); setMessage(error?.message ?? tr('settings.saveFailed')); }).finally(() => setBusy(false));
  };
  // Release history from our own host RPC (GitHub Releases API, TTL-cached);
  // installed vs latest is decided by a plain version comparison. The dshmarket
  // API below stays only for the actual install operation.
  const loadReleases = (force = false) => {
    const seq = ++checkSeq.current;
    setCheckState('loading');
    const run = attempt => (typeof remote.releaseHistory === 'function'
      ? remote.releaseHistory({ force: force || attempt > 0 }, undefined)
      : Promise.reject(new Error('releaseHistory RPC unavailable')))
      .then(result => {
        if (!result.ok) throw new Error(result.error?.message ?? 'rpc error');
        if (checkSeq.current !== seq) return;
        setReleaseInfo({ list: result.value.releases, checkedAt: result.value.checkedAt });
        setCheckState('ready');
      }).catch(() => {
        if (checkSeq.current !== seq) return;
        // One silent retry for transient GitHub hiccups, then an honest failure.
        if (attempt === 0) setTimeout(() => run(1), 2000);
        else setCheckState('failed');
      });
    run(0);
  };
  useEffect(() => { loadReleases(false); }, [remote]);
  // One-click update via the dshmarket public update API (v1). Same-origin fetch
  // from the settings page carries the host session cookie.
  // Release-archive installs are name-replace-protected by the market guard
  // ("installed from an archive link…"); swap the raw refusal for actionable text.
  const friendlyFailure = raw => (/archive|压缩包/i.test(raw ?? '') ? tr('settings.update.archiveHint') : raw);
  const runUpdate = () => {
    setUpdateInfo(info => ({ phase: 'updating', latestVersion: info?.latestVersion }));
    (async () => {
      const res = await fetch('/dsh-market/api/v1/updates', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageName: PACKAGE }) }).catch(() => null);
      const created = res ? await res.json().catch(() => null) : null;
      // The POST wraps the operation in `operation`; handle a bare shape defensively.
      const operation = created?.operation ?? created;
      const operationId = operation?.operationId;
      if (!res || res.status !== 202 || !operationId) {
        setUpdateInfo({ phase: 'failed', message: friendlyFailure(operation?.failure?.message) ?? 'HTTP ' + (res ? res.status : 'network') });
        return;
      }
      for (let i = 0; i < 120; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const opRes = await fetch('/dsh-market/api/v1/operations?operationId=' + encodeURIComponent(operationId)).catch(() => null);
        const op = opRes ? await opRes.json().catch(() => null) : null;
        const record = op?.operation ?? op;
        const state = record?.state;
        if (state === 'succeeded') { setUpdateInfo({ phase: 'updated', latestVersion: record?.installedVersion }); return; }
        if (state === 'failed' || state === 'cancelled' || state === 'rolled-back') {
          const code = record?.failure?.code;
          // Re-running an update when the source is already at the installed
          // version is not a failure — it means we are up to date.
          setUpdateInfo({ phase: code === 'already-installed' ? 'uptodate' : 'failed',
            message: friendlyFailure(record?.failure?.message) ?? state });
          return;
        }
      }
      setUpdateInfo({ phase: 'failed', message: 'operation timeout' });
    })();
  };
  const checkedAtText = releaseInfo ? tr('settings.versions.checkedAt').replace('{t}',
    new Date(releaseInfo.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : '';
  const uptodateRow = () => h('div', { className: 'dsh-suggest-flow-card' },
    h('div', { className: 'dsh-suggest-flow-verrow' },
      h('span', { className: 'dsh-suggest-flow-vernum' }, tr('settings.versions.uptodate')),
      h('span', { className: 'dsh-suggest-flow-pill' }, `v${PLUGIN_VERSION}`),
      h('span', { className: 'dsh-suggest-flow-vertime' }, checkedAtText)));
  const renderVersions = () => {
    if (checkState === 'loading') {
      return h('div', { className: 'dsh-suggest-flow-card' },
        h('div', { className: 'dsh-suggest-flow-verrow' },
          h('span', { className: 'dsh-suggest-flow-vernum' }, tr('settings.versions.checking'))));
    }
    if (checkState === 'failed') {
      return h('div', { className: 'dsh-suggest-flow-card' },
        h('div', { className: 'dsh-suggest-flow-verrow' },
          h('span', { className: 'dsh-suggest-flow-vernum' }, tr('settings.versions.failed')),
          h('button', { type: 'button', className: 'dsh-suggest-flow-ghostbtn', style: { marginLeft: 'auto' },
            onClick: () => loadReleases(true) }, tr('settings.versions.retry'))));
    }
    const list = releaseInfo?.list ?? [];
    const latest = list[0] ?? null;
    if (!latest || compareVersions(latest.version, PLUGIN_VERSION) <= 0) return uptodateRow();
    return h('div', { className: 'dsh-suggest-flow-card' },
      h('div', { className: 'dsh-suggest-flow-verhead' },
        h('div', { className: 'dsh-suggest-flow-verhead-icon' }, '⬇'),
        h('div', {},
          h('div', { className: 'dsh-suggest-flow-vertitle' },
            tr('settings.versions.available').replace('{v}', latest.version)),
          latest.date ? h('div', { className: 'dsh-suggest-flow-verdate' },
            tr('settings.versions.published').replace('{d}', latest.date)) : null),
        h('button', { type: 'button', className: 'dsh-suggest-flow-linkbtn', style: { marginLeft: 'auto' },
          onClick: () => setExpanded(value => !value) },
          expanded ? `${tr('settings.versions.collapse')} ⌃` : `${tr('settings.versions.expand')} ⌄`)),
      expanded ? list.slice(0, MAX_VERSION_ROWS).map((release, index) =>
        h('div', { key: release.version, className: 'dsh-suggest-flow-verrow' },
          h('span', { className: 'dsh-suggest-flow-vernum' }, release.version),
          index === 0 ? h('span', { className: 'dsh-suggest-flow-pill' }, tr('settings.versions.latest')) : null,
          release.version === PLUGIN_VERSION ? h('span', { className: 'dsh-suggest-flow-pill' }, tr('settings.versions.installed')) : null,
          h('span', { className: 'dsh-suggest-flow-vertime' }, release.date ?? ''),
          index === 0 ? h('button', { type: 'button', className: 'dsh-suggest-flow-ghostbtn',
            disabled: updateInfo?.phase === 'updating', onClick: runUpdate },
            updateInfo?.phase === 'updating' ? tr('settings.update.updating') : tr('settings.update.button')) : null))
        : null,
      h('div', { className: 'dsh-suggest-flow-verfoot' }, checkedAtText));
  };
  const toggleRow = (key, label) => h('label', { className: 'dsh-suggest-flow-setrow' },
    h('span', { className: 'dsh-suggest-flow-rowlabel' }, label),
    h(SettingsSwitch, { checked: config[key], busy, onChange: value => update({ [key]: value }) }));
  return h('div', { 'data-suggest-flow-settings': '', style: { maxWidth: '560px' } },
    h('div', { className: 'dsh-suggest-flow-head' },
      h('div', { className: 'dsh-suggest-flow-head-icon' }, '💡'),
      h('div', {},
        h('div', { className: 'dsh-suggest-flow-title' }, tr('settings.title')),
        h('div', { className: 'dsh-suggest-flow-subtitle' }, tr('settings.subtitle')))),
    !config ? h('p', { role: 'status', className: 'dsh-suggest-flow-msg' }, tr('settings.loading')) : [
      h('div', { className: 'dsh-suggest-flow-group' }, tr('settings.group.behavior')),
      h('div', { className: 'dsh-suggest-flow-card' },
        h('label', { className: 'dsh-suggest-flow-setrow' },
          h('span', { className: 'dsh-suggest-flow-rowlabel' }, tr('settings.enabled')),
          h(SettingsSwitch, { checked: config.enabled, busy, onChange: value => update({ enabled: value }) })),
        h('label', { className: 'dsh-suggest-flow-setrow' },
          h('div', {},
            h('div', { className: 'dsh-suggest-flow-rowlabel' }, tr('settings.count')),
            h('div', { className: 'dsh-suggest-flow-rowdesc' }, tr('settings.countDesc'))),
          h('select', { className: 'dsh-suggest-flow-select', value: String(config.count), disabled: busy,
            onChange: event => update({ count: Number(event.target.value) }) },
            [1, 2, 3, 4].map(n => h('option', { key: n, value: String(n) }, String(n)))))),
      h('div', { className: 'dsh-suggest-flow-group' }, tr('settings.group.interaction')),
      h('div', { className: 'dsh-suggest-flow-card' },
        toggleRow('doubleClickSend', tr('settings.doubleClickSend')),
        toggleRow('hideWhenTyping', tr('settings.hideWhenTyping')),
        toggleRow('keyboard', tr('settings.keyboard'))),
      h('div', { className: 'dsh-suggest-flow-group' }, tr('settings.group.data')),
      h('div', { className: 'dsh-suggest-flow-card' },
        h('div', { className: 'dsh-suggest-flow-setrow' },
          h('div', {},
            h('div', { className: 'dsh-suggest-flow-rowlabel' }, tr('settings.resetMemory')),
            h('div', { className: 'dsh-suggest-flow-rowdesc' }, tr('settings.resetMemoryDesc'))),
          h('button', { type: 'button', className: 'dsh-suggest-flow-ghostbtn', disabled: busy,
            onClick: () => { setBusy(true); setMessage('');
              remote.resetMemory().then(result => {
                if (result.ok) setMessage(tr('settings.memoryCleared'));
                else setMessage(result.error?.message ?? tr('settings.saveFailed'));
              }).catch(error => setMessage(error?.message ?? tr('settings.saveFailed'))).finally(() => setBusy(false)); },
            }, tr('settings.resetMemoryShort')))),
      h('div', { className: 'dsh-suggest-flow-group', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', {}, tr('settings.group.update')),
        h('button', { type: 'button', className: 'dsh-suggest-flow-linkbtn',
          disabled: checkState === 'loading' || updateInfo?.phase === 'updating',
          onClick: () => loadReleases(true) }, tr('settings.versions.check'))),
      updateInfo?.phase === 'updated' ? h('p', { role: 'status', className: 'dsh-suggest-flow-msg' }, tr('settings.update.done')) : null,
      updateInfo?.phase === 'failed' ? h('p', { role: 'status', className: 'dsh-suggest-flow-msg' }, `${tr('settings.update.failed')}：${updateInfo.message ?? ''}`) : null,
      renderVersions(),
      message && h('p', { role: 'status', className: 'dsh-suggest-flow-msg' }, message),
    ]);
}

// 'locale' is deliberately NOT declared in exports.inject: when the service is
// missing in a build, a declared inject would abort the whole plugin. Probe it
// instead — when present, register the dictionaries and mark both slots as
// localized (the host then injects `t`); when absent, the built-in strings cover
// the UI.
exports.inject = ['slots', 'remote', 'uiConversation'];
exports.apply = async function apply(ctx) {
  console.info(`[suggest-flow] client bundle v${PLUGIN_VERSION} loaded`);
  await ctx.remote.$mount({ package: PACKAGE, descriptors: [descriptor(), refreshSuggestionsDescriptor(), cachedSuggestionsDescriptor(), configDescriptor(), setConfigDescriptor(), feedbackDescriptor(), resetMemoryDescriptor(), releaseHistoryDescriptor()] });
  let localeReady = false;
  try {
    if (typeof ctx.locale?.register === 'function') {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), `${PACKAGE}: dictionaries`);
      localeReady = true;
    }
  } catch { /* locale unavailable in this build */ }
  const dockLocale = localeReady ? { locale: NS } : {};
  const sectionLocale = localeReady
    ? { locale: NS, label: () => { try { return ctx.locale.bind(NS)('settings.nav'); } catch { return FALLBACK['settings.nav']; } } }
    : { label: () => FALLBACK['settings.nav'] };
  // The settings shell hands every non-reserved section the default gear and has no
  // icon field (same limitation the predecessor plugin documents) — patch our nav
  // row's glyph by label lookup instead. Labels are our own, so this can never
  // touch the predecessor plugin's nav row when both are installed. Re-applies
  // whenever the panel re-portals; silently no-ops when the markup doesn't match.
  try {
    const NAV_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
      + '<rect x="1.5" y="2.6" width="9.5" height="3.2" rx="1.6" fill="currentColor" opacity=".95"/>'
      + '<rect x="3.6" y="6.9" width="9.9" height="3.2" rx="1.6" fill="currentColor" opacity=".62"/>'
      + '<rect x="1.8" y="11.2" width="7.2" height="3.2" rx="1.6" fill="currentColor" opacity=".38"/></svg>';
    const navLabels = [FALLBACK['settings.nav'], DICTIONARIES.en['settings.nav']].map(s => (s || '').trim()).filter(Boolean);
    let lastPatch = 0;
    const patchNav = () => {
      const now = Date.now();
      if (now - lastPatch < 500) return;
      lastPatch = now;
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        if (el.getAttribute('data-dsh-suggest-flow-nav') === '1') continue;
        const text = (el.textContent || '').trim();
        if (!navLabels.includes(text)) continue;
        const svg = el.querySelector('svg');
        if (!svg) continue;
        const tpl = document.createElement('template');
        tpl.innerHTML = NAV_SVG;
        svg.replaceWith(tpl.content.firstChild);
        el.setAttribute('data-dsh-suggest-flow-nav', '1');
        break;
      }
    };
    const navObserver = new MutationObserver(() => { try { patchNav(); } catch { /* markup changes: gear stays */ } });
    ctx.effect(() => {
      navObserver.observe(document.body, { childList: true, subtree: true });
      patchNav();
      return () => navObserver.disconnect();
    }, `${PACKAGE}: nav icon`);
  } catch { /* best effort: the default gear stays */ }
  ctx.inject(['remote.suggestFlow'], scope => {
    const remote = scope.get('remote.suggestFlow');
    const generate = async (input, signal) => {
      const result = await remote.recommend(input, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    const refreshSuggestions = async (input, signal) => {
      const result = await remote.refreshSuggestions(input, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    // Cache-first with silent fallback: old replies restore from cache when present,
    // otherwise generate once (cached afterwards). Failures stay invisible.
    const restoreOrGenerate = async (input, signal) => {
      let cached = { ok: false };
      try { cached = await remote.cachedSuggestions(input, signal); } catch { /* fall through to generate */ }
      if (cached.ok && Array.isArray(cached.value) && cached.value.length) return cached.value;
      return generate(input, signal);
    };
    scope.slots.inject('conversation.input.dock', () => scope.slots.register({
      name: 'conversation.input.dock', id: PACKAGE, order: 15, ...dockLocale,
      inject: () => ({ generate, restoreOrGenerate, refresh: refreshSuggestions, remote }),
    }, ChipsRow));
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: PACKAGE, order: 70, ...sectionLocale,
      inject: () => ({ remote }),
    }, SettingsSection));
  });
};
