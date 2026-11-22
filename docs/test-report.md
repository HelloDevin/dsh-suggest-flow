# 测试报告

> dsh-suggest-flow v0.1.0 · 测试日期 2026-11-22 · Node v22.22.2 (win32)

## 1. 测试环境与方法

| 项目 | 内容 |
|---|---|
| 构建 | `node scripts/build.mjs`（零依赖构建，每次测试前干净重建 lib/） |
| 宿主集成测试 | `scripts/host-test.mjs`：stub `@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-home-paths`（临时目录 resolveDshHome），stub `ctx.llm.stream`，真实加载 `lib/index.mjs` 走完 `apply()` → 服务实例 → RPC 方法全链路 |
| 渲染冒烟测试 | `scripts/render-test.mjs`：执行构建产物 `lib/client.js`（`__ModuleLoader` 包装 + 内联 common），React stub 挂载两个插槽组件，microtask 级 flush（mount effects → RPC → state → re-render） |
| CI | GitHub Actions：node 22 / 24 矩阵，Ubuntu，构建 + 两套测试（`.github/workflows/test.yml`） |

## 2. 宿主集成测试结果 —— 50 项全部通过

### 2.1 Prompt 解析与本地质量过滤（13 项）

- ✅ `{t,i}` 对象协议解析、意图保留、顺序保持
- ✅ 纯字符串数组兼容（无徽标降级）
- ✅ ```json 围栏 + 散文包裹提取
- ✅ 引号剥离、markdown 强调剥离、空白折叠
- ✅ 客套话/助手腔块名单过滤
- ✅ 用户最新问题回声过滤（整句或片段）
- ✅ 包含式近重去重（短碎片让位长句）
- ✅ 超长(>80)/过短(<4)/换行/斜杠命令拒绝
- ✅ avoid 集合再过滤（刷新去重）
- ✅ 方向轮转交错（explore→expand→apply→未标注）
- ✅ 数量截断（count 上限）
- ✅ 非法意图降级为无徽标（不丢建议）
- ✅ 空数组/空输入/元列表行（"以下是建议："）拒绝

### 2.2 RPC 结果编解码（3 项）

- ✅ validateSuggestions 规范化（字符串升级对象、大写意图归一）
- ✅ 非法条目（缺文本字段）拒绝
- ✅ 超过 4 条拒绝

### 2.3 服务全链路（15 项）

- ✅ apply() 忽略宿主未知配置键
- ✅ 8 个 RPC 全部注册（含新增 refreshSuggestions）
- ✅ 生成→解析→意图对象返回
- ✅ DeepSeek 强制 `reasoningEffort: 'off'`、maxTokens=120×count+80
- ✅ 服务层缓存命中零模型调用
- ✅ 设置补丁未知键丢弃 + keyboard 开关生效
- ✅ cachedSuggestions 只读恢复 / miss 返回空且零调用
- ✅ enabled=false：recommend 返回空、refresh 抛错且零调用
- ✅ hint 收录被采纳文本

### 2.4 手动刷新（8 项）

- ✅ force 绕过缓存产生新调用
- ✅ 刷新结果替换条目
- ✅ user message 携带 `已展示过` avoid 列表（含历史采纳文本）
- ✅ 6s 冷却内拒绝（错误信息可识别，客户端保留原组）
- ✅ 模型只回已展示内容时抛错且**不替换**（"生成失败保留原建议"）
- ✅ 二次刷新替换并保留意图标注
- ✅ shownHistory 累积被替换的历史组、refreshCount 计数
- ✅ avoid 覆盖当前组+历史组；每轮 5 次上限强制（不再产生调用）

### 2.5 反馈与方向偏置（5 项）

- ✅ fill 反馈自动归属意图（来自当前建议集）
- ✅ 偏置在阈值（<3 条）下保持静默
- ✅ ≥3 条带意图采纳后偏置生效（「实际应用」）
- ✅ 偏置 hint 同时保留采纳文本

### 2.6 记忆迁移与清理（4 项）

- ✅ 旧插件 memory.json 一次性种子导入（string 建议升级对象形状）
- ✅ 种子历史进入偏好 hint
- ✅ 种子持久化到自有存储文件（`storages/dsh-suggest-flow/memory.json`）
- ✅ resetMemory 清空缓存+hint+磁盘文件

### 2.7 版本检查（4 项）

- ✅ parseReleases 丢弃 draft/prerelease/非法 tag/去重排序
- ✅ compareVersions 三段比较
- ✅ releaseHistory 30 分钟 TTL（单次 fetch）
- ✅ force 绕过缓存

## 3. 渲染冒烟测试结果 —— 7 阶段全部通过

| 阶段 | 验证内容 |
|---|---|
| ChipsRow 首渲染 | 组件函数执行、hook 顺序稳定、无 TDZ/未定义引用 |
| Dock flush（effects 开） | cache-restore → chips 渲染：1 枚 chip、文本/悬停 title 正确、方向圆点 `is-explore` + 中文方向 title「深入探索」、⟳ 按钮存在且 title「换一组建议」、shown 印记已上报 |
| 单击/双击 | 单击填入草稿 + fill 反馈；300ms 内二次点击触发 submit + send 反馈 |
| 手动刷新 | 点击 → 状态更新 → RPC → 行内容整体替换（旧文本消失、2 枚新 chip、apply/expand 圆点正确） |
| SettingsSection 首渲染 | 设置骨架渲染 |
| Settings flush | releaseHistory RPC → 非加载态：「可更新到 9.9.9」头部卡、发布日期、latest 徽标、恰好 5 行版本列表、检查时间页脚 |
| 客户端 apply() | `$mount` 8 描述符、locale 探测注册、`remote.suggestFlow` 注入、双插槽注册 |

## 4. 稳定性场景覆盖（逻辑层）

| 场景 | 覆盖方式 | 结果 |
|---|---|---|
| 模型超时 | AbortSignal.any([caller, timeout]) 组合 + 独立 timeoutMs | 逻辑在位（真实时钟行为未测） |
| 网络中断/模型异常 | llm.stream 抛错 → refresh 抛错、条目不动、recommend 静默 | ✅ 测试通过 |
| JSON 解析失败 | 围栏/切片/行回退三级 + 全部非法 → 空列表 | ✅ 测试通过 |
| 记忆文件损坏 | readJson try/catch → 空Map启动 | 逻辑在位（同原插件实现） |
| 连续生成 | 缓存键含 turns 签名，同上下文不重复调用 | ✅ 测试通过 |
| 快速切换会话 | refresh 随 sessionId/replyKey 变更中止 | ✅ 测试通过（签名守卫） |
| 多请求竞争 | fan-in 共享 job、并发上限 2、force 满载 throw 保旧组 | ✅ 测试通过 |
| 插件关闭重启 | memory/settings 落盘 + 重载（进程内模拟） | ✅ 测试通过 |
| 防旧请求覆盖新会话 | request.current 一致性校验 + abort | 继承原插件实现，逻辑在位 |

## 5. 真实宿主验证（2026-11-23，DSH Desktop 0.2.2-rc.5）

在真实 `profiles/desktop`（与 dsh-suggestion-chips 0.4.12 同装）中通过 `dsh plugin --profile desktop add` 安装并完全重启宿主，全部通过：

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 安装（pnpm link 模式）+ 宿主识别加载 | ✅ `dsh plugin list` 显示 dsh-suggest-flow 0.1.0；应用重启无报错、无新增 crash 日志 |
| 2 | 与原插件同装共存 | ✅ 两插件同时加载，应用正常启动 |
| 3 | 设置页集成 | ✅ 导航出现「智能追问」（含自定义图标补丁）；分区完整渲染：标题/副标题(v0.1.0)、4 个开关、条数选择、清空按钮 |
| 4 | 版本检查 RPC | ✅ 「已是最新版本 检于 HH:MM」——真实 GitHub Releases 数据 + 版本比较 |
| 5 | 真实生成 | ✅ 发送「用两句话介绍一下什么是闭包？」→ 回复结束后出现 2 条建议（explore/apply 圆点），文案具体可发送 |
| 6 | 方向系统 | ✅ 真实 LLM 输出结构化意图，圆点渲染正确（is-explore/is-expand/is-apply） |
| 7 | 单击填入 | ✅ 草稿填入，行保持显示（chip 填入不算打字） |
| 8 | 手动刷新 | ✅ 共 6 次真实刷新（测试 4 次 + 用户自发使用 2 次）：每组均全新、零重复（avoid 生效）、三方向覆盖、场景路由随对话自适应 |
| 9 | 记忆持久化 | ✅ `storages/dsh-suggest-flow/memory.json` 原子写入（15 条），refreshCount/shownHistory/items 正确 |
| 10 | 旧插件迁移 | ✅ 一次性只读种子导入 14 条旧采纳历史（fill/send 状态保留）；原文件未改动 |
| 11 | 缓存恢复 | ✅ 设置页往返后 chips 从缓存秒恢复 |
| 12 | 宿主稳定性 | ✅ 深色主题下视觉正常；boot 日志干净 |

## 6. 未验证项（诚实清单）

以下项仍未在真实宿主中验证（详见[已知问题 §1.1](known-issues.md)）：

- 键盘流在真实 UI 中的按键级端到端操作
- dshmarket 一键更新的端到端升级执行
- 浅色主题的完整视觉巡检

## 7. 结论

- 本地可验证部分：**50+ 项宿主断言 + 7 阶段渲染冒烟全部通过**，构建可重复、产物结构正确；
- 真实宿主部分：**端到端验证通过**（DSH Desktop 0.2.2-rc.5，含与原插件同装、真实模型调用、刷新、持久化与迁移）；
- 剩余未验证项仅键盘流按键级操作、一键升级执行与浅色主题巡检。
