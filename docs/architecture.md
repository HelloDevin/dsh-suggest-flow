# dsh-suggest-flow 架构文档

> 版本 0.1.0 · DSH（DeepSeek Harness 0.2.x）插件
> 前置阅读：[原插件分析](analysis/original-plugin-analysis.md)（宿主协议事实来源）

## 1. 项目定位

**Smart Suggestion Plugin for DSH** —— 面向 DSH 的轻量级 AI 智能建议追问插件。在 DSH 输入框上方给出 **Explore / Expand / Apply** 三个意图方向的追问 chips，支持单击填入、双击发送、键盘流和一键换一组。

开发策略：**轻量优先**。不引入 Agent 工作流、任务执行系统或额外质量评估模型；每轮常规生成最多一次辅助模型调用。

## 2. 目录结构

```
dsh-suggest-flow/
├── dsh.plugin.json          # DSH 插件 Manifest（id/version/main/engines）
├── package.json             # dsh.bundle.patch / dsh.client 注入声明 + peerDependencies
├── cordis.patch.yml         # 宿主插件树插入点（id: suggest-flow）+ 默认配置
├── icon.png                 # 插件图标（scripts/make-icon.mjs 生成，零依赖）
├── locale/zh.json|en.json   # marketplace 展示元信息
├── src/
│   ├── common.mjs           # 协议描述符 + 校验 + 本地质量过滤（宿主/客户端共用）
│   ├── engine.mjs           # Prompt 模板 + 模型调用 + 建议解析（含 force/avoid）
│   ├── index.mjs            # 宿主入口：服务类 + Typert RPC 注册 + 存储
│   └── client.cjs           # 客户端源码（构建时内联进 lib/client.js）
├── lib/                     # 构建产物（lib/index.mjs + lib/client.js + 副本）
├── scripts/                 # build / host-test / render-test / make-icon
└── docs/                    # 本文档集
```

构建是**零依赖**的：`scripts/build.mjs` 把 `src/common.mjs`（去 export）与 `src/client.cjs` 内联包装为 `window.__ModuleLoader__.load({id:'dsh-suggest-flow', factory})` 形式的客户端 bundle，同时原样复制宿主 ESM 入口到 `lib/`。无 bundler、无 node_modules 构建依赖。

## 3. 双端结构

```
┌─ DSH 客户端（web）────────────────────────────┐
│ lib/client.js（__ModuleLoader__ bundle）        │
│  exports.inject = ['slots','remote','uiConversation'] │
│  apply(ctx):                                    │
│   1. ctx.remote.$mount({package, descriptors×8})│
│   2. 探测式 locale 注册（缺服务则内置字典兜底）   │
│   3. ctx.inject(['remote.suggestFlow'], ...)    │
│   4. slots.inject('conversation.input.dock')    │  → ChipsRow
│      slots.inject('settings.section')           │  → SettingsSection
└──────────────┬──────────────────────────────────┘
               │ Typert RPC（strict codec，signal 可取消）
┌─ DSH 宿主（node）─────────────────────────────┐
│ lib/index.mjs — name=dsh-suggest-flow, inject=['llm','typert'] │
│ apply(ctx, config): 忽略未知配置键 → ctx.plugin(SuggestFlow)   │
│   → ctx.typert.register({package, face:'host', invocations×8}) │
│ SuggestFlow extends TypertRemoteService:        │
│   两层缓存 + memory.json/settings.json 原子持久化│
│   engine = createRecommender(ctx.llm, getConfig)│
└─────────────────────────────────────────────────┘
```

### 3.1 RPC 一览（8 个，全部 `kind: 'direct'` + signal 取消 + strict codec）

| method | 方向 | 说明 |
|---|---|---|
| `recommend` | client→host | 常规生成（缓存命中则直接返回） |
| `refreshSuggestions` | client→host | **新增**：手动换一组（强制新调用 + avoid 过滤 + 冷却/上限） |
| `cachedSuggestions` | client→host | 只读缓存恢复，绝不触发模型调用 |
| `chipSettings` / `applyChipSettings` | client→host | 设置快读/更新（未知键丢弃，向后兼容） |
| `recordFeedback` | client→host | shown / fill / send 反馈，方向归属在宿主侧补全 |
| `resetMemory` | client→host | 清空采纳记忆与建议缓存 |
| `releaseHistory` | client→host | GitHub Releases（30 分钟 TTL，force 绕过） |

描述符模板与原插件逐字段同构（`id: ${PACKAGE}#${method}`、`invocation.kind`、`codec.mode: 'strict'`、`cancellation.parameter: 'signal'`），仅 PACKAGE/SERVICE 换为 `dsh-suggest-flow` / `suggestFlow`——协议字段名是宿主识别约定，未做任何改名。

## 4. 核心数据流

### 4.1 常规生成（每轮最多 1 次模型调用）

```
会话 running true→false（当前 sessionId 亲眼观察；水合/切会话不算）
→ selectContext: 转录 → 最近 N 轮（最新轮 user≤400/assistant≤1200，历史轮减半，代码块折叠，工具调用一行）
→ remote.recommend({sessionId, replyId, provider, model, turns})
→ 宿主服务层缓存命中 → 直接返回
→ engine: system prompt（方向定义+场景路由+规则）+ hint（偏好）‖ user JSON {对话:[…]}
→ ctx.llm.stream 一次调用（maxTokens=120×count+80，DeepSeek 关 reasoning）
→ parseSuggestions: JSON 提取 → 规范化 → 垃圾/回声/近重过滤 → 方向轮转 → ≤count 条 {text,intent?}
→ 服务层缓存 + 800ms 防抖原子写 memory.json
→ 客户端渲染 chips（方向圆点 + stagger 入场）
```

### 4.2 手动刷新（新增流程）

```
用户点击 ⟳ → remote.refreshSuggestions(同 recommend 入参)
→ 宿主校验：启用？有条目？冷却 6s 内？本轮刷新 ≥5 次？ → 任一失败 throw（客户端保留原建议）
→ avoid = 当前建议 ∪ shownHistory（≤12 条）
→ engine force 路径：绕过两层缓存与并发共享，user JSON 附 {已展示过: avoid}
→ 生成成功且过滤后非空 → 替换 entry.suggestions，旧文案进 shownHistory，refreshCount+1
→ 生成失败/全被过滤 → throw → 客户端静默保留原建议
→ 客户端按钮 6s 软冷却（镜像宿主常量），期间禁点
```

失败路径全部 throw（而非返回空）是刻意的：返回 `[]` 是"合法的零建议"，会让客户端隐藏整行；throw 才能让客户端区分"失败保留"与"成功替换"。

### 4.3 新回合判定（防误生成，继承原插件）

- `wasRunningRef`：只对亲眼看到 running true→false 的**当前会话**回合允许模型调用；
- 重开/水合中的旧回合一律走 `cachedSuggestions`（cache-only）；
- `generatedRef`：同一 (session, reply, turns 签名) 只生成一次；
- effect 内部以依赖签名 ref 作守卫——真实 React 下与 dep 数组等价，测试替身（每渲染都跑 effect）下保持一次语义。

## 5. 存储

`resolveDshHome()/storages/dsh-suggest-flow/`（与原插件目录互不重叠）：

- `settings.json`：设置页 overrides（原子写，优先于 cordis.patch.yml 默认值）；
- `memory.json`：`{entries: {"sessionId::replyId": entry}}`，entry 含 `suggestions:[{text,intent?}]`、`items:[{text,state,intent?}]`、`shownHistory:[text]`、`refreshCount`、`lastRefreshAt`、`ts`；滚动窗口 400 条 / 30 天；
- **一次性种子导入**：自身 memory.json 缺失时，只读尝试 `storages/dsh-suggestion-chips/memory.json`（同构 schema，string 建议自动升级为对象形状），此后只写自己的文件——实现"优先复用原项目 memory.json"且无双向写耦合。

## 6. 客户端 UI

- `conversation.input.dock` 插槽（order 15）：宽度实测对齐 composer 卡片（ResizeObserver）；grid-rows + opacity 进出场；chips stagger 入场（`prefers-reduced-motion` 适配）；退出纯渐隐并保持高度后无动画回收。
- **方向徽标**：建议文本前一枚 6px 圆点——explore 蓝（主题变量）、expand 紫、apply 绿（固定色值，深浅色通用）；`title` 显示本地化方向名；无意图的建议不显示圆点（降级兼容）。
- **刷新按钮**：行尾 26px 圆形图标按钮，刷新中 `⟳` 旋转动画；刷新中与冷却期禁用；键盘芯片导航不包含它（Tab 可达，不干扰方向键流）。
- **键盘流**（与原插件一致）：↑ 激活、←→↑↓ 二维循环（按渲染行分组就近对齐）、Enter 填入/确认发送、Ctrl+Enter 直接发送、Esc/输入字符退出；草稿含用户自输内容时 Enter 不劫持；chip 填入的草稿不算"打字"。
- **设置页分区**（order 70）：启用、条数(1-4)、双击发送、打字隐藏、键盘开关、清空记忆、版本区块（自动检查 + 一键更新，指向 `HelloDevin/dsh-suggest-flow`）。
- 设置改动即时生效：客户端每回合重读 `chipSettings` 快照。

## 7. 与原插件共存（同装约束）

| 资源 | dsh-suggestion-chips | dsh-suggest-flow |
|---|---|---|
| 插件 ID / cordis 节点 id | `dsh-suggestion-chips` / `suggestion-chips` | `dsh-suggest-flow` / `suggest-flow` |
| Typert service/namespace | `suggestionChips` | `suggestFlow` |
| RPC 描述符 id 前缀 | `dsh-suggestion-chips#…` | `dsh-suggest-flow#…` |
| 本地存储目录 | `storages/dsh-suggestion-chips/` | `storages/dsh-suggest-flow/` |
| locale NS | `suggestion-chips` | `suggest-flow` |
| CSS 类前缀 / style tag id | `dsh-suggestion-chips-*` / `…-chips-style` | `dsh-suggest-flow-*` / `…-flow-style` |
| data 属性 | `data-suggestion-chips-dock` 等 | `data-suggest-flow-dock` 等 |
| 设置页 nav 文案（图标补丁按文案匹配） | 建议追问 / Suggestion Chips | 智能追问 / Suggest Flow |
| dock/section 注册 | order 15 / 70，id=包名 | order 15 / 70，id=包名（同插槽多插件并存由宿主堆叠） |

注意：两个插件同装时各自都会生成建议（各自独立调用模型），这是用户的显式选择；本项目不读取、不写入、不抑制对方的任何状态。

## 8. 兼容性红线（实现自查清单）

1. `engines.dsh = ">=0.2.2-rc.1 <0.3.0-0"`、`peerDependencies` 四件套与原插件实测区间一致；
2. Manifest / package.json / cordis.patch.yml 三件套结构逐字段同构，仅品牌字段更换；
3. 描述符结构、codec 模式、取消参数、`$mount` 形状、slot 名称、宿主 hooks 用法（`useInput/useSession/useConversation/useProjection/inputActions`）全部沿用实测过的用法；
4. `exports.inject = ['slots','remote','uiConversation']`；locale 探测式注册 + 内置字典兜底（缺服务不致命）；
5. 宿主侧只认领 `CONFIG_KEYS` 内的配置键，宿主注入的未知键忽略不拒识；
6. 未虚构任何 DSH API——所有宿主接口用法均来自原插件可运行源码。
