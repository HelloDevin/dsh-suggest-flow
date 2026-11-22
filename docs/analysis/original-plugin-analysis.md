# 原插件分析：dsh-suggestion-chips

> 分析对象：<https://github.com/HelloDevin/dsh-suggestion-chips>（v0.4.12，commit `839f8f7`）
> 分析方式：完整阅读 `src/` 全部源码、`dsh.plugin.json`、`package.json`、`cordis.patch.yml`、构建与测试脚本、locale 资源，不依赖 README 描述。
> 目的：为 dsh-suggest-flow 提供可复用模块清单、必须继承的宿主协议约束，以及需要优化的问题。

---

## 1. 宿主环境与插件体系（实测自源码）

DSH 是基于 cordis（Koishi 衍生）插件体系的桌面 AI 客户端（DeepSeek Harness 0.2.x）。原插件实测依赖的宿主协议如下——**这些是本文件最重要的结论，新插件必须逐项继承**：

### 1.1 插件 Manifest（`dsh.plugin.json`）

| 字段 | 原插件取值 | 说明 |
|---|---|---|
| `id` | `dsh-suggestion-chips` | 全局唯一插件 ID；存储目录、RPC 命名空间、客户端 bundle id 都由它派生 |
| `version` | `0.4.12` | 与 package.json 同步 |
| `main` | `lib/index.mjs` | 宿主侧入口 |
| `description` | 一句话描述 | 展示用 |
| `engines.dsh` | `>=0.2.2-rc.1 <0.3.0-0` | 宿主版本兼容区间（实测验证过的区间，新插件沿用） |
| `contributes` | `{tools:[], skills:[]}` | 本插件不贡献 tools/skills |

### 1.2 `package.json` 中的 DSH 专有字段

```jsonc
{
  "type": "module",                    // 宿主侧入口是 ESM
  "main": "lib/index.mjs",
  "exports": { ".": "./lib/index.mjs", "./client": "./lib/client.js", "./locale/*.json": "./locale/*.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 声明宿主插件树插入点与默认配置
    "client": {
      "platform": "web",
      "inject": [                        // 客户端 bundle 需要的宿主前端模块
        "@deepseek-ai/dsh-api-gateway",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-chat",
        "@deepseek-ai/dsh-client-ui-settings"
      ]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/dsh": ">=0.2.2-rc.1 <0.3.0-0",
    "@deepseek-ai/cordis": "~4.0.4 || ~4.1.0",
    "@deepseek-ai/dsh-typert-protocol": ">=0.2.2-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-home-paths": ">=0.2.2-rc.1 <0.3.0-0"
  }
}
```

### 1.3 `cordis.patch.yml`（宿主插件树插入）

```yaml
- insert:
    - id: suggestion-chips        # 插件树节点 id
      name: dsh-suggestion-chips  # 必须等于插件包名
      config: { ...默认配置 }       # 静态默认配置，可被用户 profile overlay 覆盖
```

### 1.4 宿主侧入口协议（`src/index.mjs`）

- `export const name = PACKAGE;` —— cordis 服务名。
- `export const inject = ['llm', 'typert'];` —— 声明依赖的宿主服务：`llm`（模型调用）、`typert`（RPC 协议注册）。
- `export function apply(ctx, config)`：
  1. 只认领自己 `CONFIG_KEYS` 内的配置键，**忽略宿主注入的未知键**（拒识会拖垮整个插件加载）；
  2. `ctx.plugin(ServiceClass, normalized);` 注册服务类；
  3. `ctx.typert.register({ package, face: 'host', schemas: [], model: {services:[],events:[],objects:[]}, invocations: [...] })` 注册 RPC。
- 服务类继承 `TypertRemoteService`（来自 `@deepseek-ai/dsh-typert-protocol`），构造时传入 `SERVICE` 名。
- 本地存储：`join(resolveDshHome(), 'storages', PACKAGE)`（`@deepseek-ai/dsh-home-paths`），原子写（tmp + rename）。

### 1.5 Typert RPC 描述符协议（`src/common.mjs`）

每个 RPC 一个描述符，统一结构（新插件必须保持同构，字段名是宿主识别的协议字段，**不可改名**）：

```js
{
  id: `${PACKAGE}#${method}`,   // 全局唯一：插件包名 + 方法名
  service: SERVICE,             // 服务名（客户端按 remote.<service> 取用）
  namespace: SERVICE,
  method,
  invocation: { kind: 'direct' },
  parameters: [{ name, wire, source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}#Xxx`, create: () => ({ parse: validateFn }) } }],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol, create: () => ({ parse }) },
}
```

原插件注册了 7 个 RPC：`recommend`、`cachedSuggestions`、`chipSettings`、`applyChipSettings`、`recordFeedback`、`resetMemory`、`releaseHistory`。

### 1.6 客户端 bundle 协议（`src/client.cjs` → 构建为 `lib/client.js`）

- 产物是**无构建依赖的手工 IIFE**：`window.__ModuleLoader__.load({id: PACKAGE, factory: function(require){...}})`，`factory` 内注入 `PLUGIN_VERSION` 并内联 common 源码（去掉 export）。CommonJS 风格（`exports.apply`、`exports.inject`）。
- `exports.inject = ['slots', 'remote', 'uiConversation']`；`exports.apply = async ctx => {...}`：
  1. `await ctx.remote.$mount({ package: PACKAGE, descriptors: [...] })` 挂载 RPC 描述符（客户端与服务端共用同一份描述符源码，保证 codec 对齐）；
  2. 探测式注册 locale：`ctx.locale?.register(NS, DICTIONARIES)`（**故意不放进 exports.inject**——某个宿主构建缺该模块时，声明式注入会让整个插件加载失败，探测式则静默降级到内置文案）；
  3. `ctx.inject(['remote.suggestionChips'], scope => ...)`：`scope.get('remote.' + SERVICE)` 取远程服务代理；
  4. `scope.slots.inject('conversation.input.dock', ...)` 注册输入框上方停靠区插槽（组件 + `inject()` 提供的 props）；`scope.slots.inject('settings.section', ...)` 注册设置页分区。
- 宿主注入给插槽组件的 props/hooks（实测用法）：
  - `useInput(selector)`：输入框状态（`value.phase`（'plain' 等）、`value.draft`）；
  - `useSession(selector)`：会话状态（`running`、`removed`）；
  - `useProjection('modelSelection', selector)`：当前模型选择；
  - `useConversation(selector, equalityFn)`：会话转录 `value.views.get('chat')?.legacy.nodes`；
  - `inputActions.setDraft(text)` / `inputActions.submit()`：填草稿与发送的原生路径；
  - `t`：locale 绑定后的翻译函数（locale 注册成功时由宿主注入）。
- 转录节点结构：`{ kind: 'user'|'assistant'|'steering', content|blocks, messageId|seq, requestConfig|providerMetadata: {provider, model} }`；assistant blocks 有 `text`、`tool-call` 两类。
- 样式注入：运行时向 `document.head` 插入 `<style>`（引用计数管理），全部颜色用宿主 `--dsw-alias-*` / `--dsh-*` CSS 变量，深浅色主题自动适配。
- 设置页"版本"区块：宿主侧 RPC 拉 GitHub Releases（30 分钟 TTL），一键升级走 dshmarket 公开 API（`POST /dsh-market/api/v1/updates` + 轮询 `/dsh-market/api/v1/operations`）。

### 1.7 模型调用接口

```js
llm.stream({
  provider, model, system, messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  tools: [], maxTokens, signal,
  ...(provider === 'deepseek' || provider.startsWith('deepseek-') ? { reasoningEffort: 'off' } : {}),
})
```
chunk：`{ type: 'text-delta', index, text }` 与 `{ type: 'block-end', block: { type: 'text', text } }`，多 index 需按 index 排序拼接。

---

## 2. 功能与数据流（实测）

### 2.1 常规生成流程

```
会话 running true→false（客户端观察当前 sessionId 的翻转；水合/切会话不算新回合）
→ 客户端 selectContext() 从转录取最近 N 轮（最新轮 user≤400/assistant≤1200，历史轮减半，代码块→[代码略]，工具调用→一行名称列表）
→ remote.recommend({sessionId, replyId, provider, model, turns})
→ 宿主：静态键缓存命中？→ 命中直接返回；未命中调 engine（ctx.llm.stream 一次调用）
→ parseSuggestions：去围栏/JSON 提取/字符串与 {text} 对象兼容/去引号/单行/≤80字/去重/截断到 count
→ 宿主缓存 + 800ms 防抖原子持久化 memory.json
→ 客户端渲染 chips（逐个 stagger 入场动画，纯渐隐退出）
```

### 2.2 缓存与"新回合"判定（关键防抖设计，必须继承）

- 宿主两层缓存：engine 内存 Map（64 条，键=sessionId+replyId+provider+model+turns+count）+ 服务层持久缓存 Map（400 条/30 天，键=sessionId::replyId）。
- 客户端 `wasRunningRef`：只对**亲眼看到 running true→false 的当前会话回合**调 `recommend`（可产生模型调用）；重开会话/水合中的旧回合一律走 `cachedSuggestions`（cache-only，绝不模型调用）。
- `generatedRef`：同一 (session, reply, turns 签名) 只生成一次，转录编辑/会话往返命中即跳过。
- engine 并发上限 2，超出直接返回 []（无后台队列）；同键并发调用 fan-in 共享一个 job；调用方取消只移除自己，最后一个取消者才 abort 下游。

### 2.3 用户偏好（memory.json）

- 键 `sessionId::replyId` → `{ suggestions: string[], items: [{text, state: 'shown'|'fill'|'send'}], ts }`；400 条 / 30 天滚动窗口。
- `buildHint()`：收集最近被采纳（fill/send，≤5 条）与被忽略（shown 且未采纳，≤3 条）文本，拼进 system prompt：「用户对以往建议的反馈(供参考…)」。1 次采纳即生效；仅忽略需要 ≥2 条（避免噪声）。偏好只影响提示词，不改本地逻辑。
- 设置页可一键清空（内存 + engine 缓存 + 磁盘文件）。

### 2.4 设置体系

- 配置键：`enabled`、`doubleClickSend`、`hideWhenTyping`、`keyboard`、`count`(1-4)、`contextTurns`(1-4)、`timeoutMs`(1000-60000)、`provider`、`model`。
- 三层：cordis.patch.yml 静态默认 < 设置页 overrides（持久化 settings.json，优先）< 实时生效（getConfig 闭包每次读取）。
- 客户端每回合重读一次 `chipSettings` 快照，设置改动无需重启。

### 2.5 交互（成熟，必须全量继承）

单击填入（替换草稿）；同 chip 300ms 内二次点击=发送（自实现双击窗口，不依赖浏览器 dblclick）；↑ 激活键盘选择、←→↑↓ 二维移动（按渲染行分组、就近对齐、循环）、Enter 填入/确认发送、Ctrl+Enter 直接发送、Esc/输入字符退出；草稿非空时 Enter 不劫持（保护用户原生输入）；打字隐藏整行（chip 填入的草稿不算"打字"）；hover title 显示全文；会话切换/回合重置清空状态；宽高与 composer 卡片实测对齐（ResizeObserver）；`prefers-reduced-motion` 适配；无障碍 role/aria。

### 2.6 更新检查

GitHub Releases（宿主侧 fetch，10s 超时，30 分钟 TTL，force 绕过）→ parseReleases 清洗（去 draft/prerelease/非 semver/去重排序，≤20 条）→ 客户端比较版本展示；升级走 dshmarket Update API v1（POST + 轮询，失败区分 `already-installed`=已是最新）。

---

## 3. 可复用模块清单（新插件继承项）

| 模块 | 处置 |
|---|---|
| Manifest/package/patch 三件套结构 | **继承**，仅换 ID/名称/默认值 |
| Typert 描述符模板与 strict codec 模式 | **继承**（协议字段不改名） |
| `compactContext`（代码折叠+头尾保留压缩） | **原样继承** |
| `selectContext`（转录→turns，含工具行） | **原样继承**（客户端侧） |
| 两层缓存 + wasRunningRef/generatedRef 新回合判定 | **原样继承** |
| engine 的 fan-in 并发管理、AbortSignal 组合、runaway 截断 | **原样继承** |
| 交互全套（单击/双击/键盘/淡出动画/宽度对齐/防误触） | **原样继承** |
| 设置页结构、切换开关、版本/更新区块 | **继承**，指向新仓库 |
| 原子写 JSON、防抖持久化、30 天/400 条滚动窗口 | **原样继承** |
| locale 探测式注册 + 内置字典兜底 | **继承** |

---

## 4. 需要优化的问题（新插件的改进点）

1. **建议同质化**：原 prompt 只要求"继续执行/验证/换角度"，三条建议常为同一意图的改写，缺乏明确的价值分层；无方向概念，无法刻意制造差异。
2. **无多样性结构化保证**：本地只有"完全重复过滤"，对"同义改写/泛泛而谈"无过滤；没有方向轮转。
3. **无手动刷新**：用户对一组建议不满意时只能等下一轮，浪费一次展示机会。
4. **偏好利用浅**：只提示"被采纳/被忽略"文本，不提取方向偏好；忽略反馈只压文本，不压类型。
5. **模型输出协议弱**：纯字符串数组，无意图标注；解析器对"凑数型"内容（客套话、回声用户问题）无防御。
6. **刷新类场景无缓存协调机制**（新功能，原项目无对应物）。
7. **品牌耦合**：storage 目录、RPC namespace、locale NS、CSS 前缀、GitHub 仓库、dshmarket 包名全部绑定旧 ID——新项目必须全套更换，避免与原插件同装冲突。

## 5. 结论：新插件兼容性红线

新插件 dsh-suggest-flow 必须：

1. 保持 §1 全部宿主协议字段/结构不变（仅替换 PACKAGE/SERVICE/NS/存储目录等品牌标识）；
2. 与原插件可同装：不同插件 ID、不同 storage 目录、不同 locale NS、不同 CSS 类前缀/样式 tag id、不同设置页 nav 文案（导航图标按文案匹配打补丁，文案撞车会互相误伤）、不同 cordis 节点 id；
3. 沿用 `engines.dsh` 同一兼容区间，不虚构宿主 API；
4. memory.json 采用同构格式（suggestions/items/ts，新字段全部可选），并支持从原插件存储**只读一次性种子导入**（只在自身存储缺失时尝试），实现"优先复用原项目 memory.json"的要求且不产生双向写入耦合。
