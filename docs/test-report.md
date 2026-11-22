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

## 5. 未验证项（诚实清单）

**没有可用的真实 DSH 测试环境。** 以下项未在真实宿主中验证，不得视为通过（详见[已知问题 §1.1](known-issues.md)）：

- 真实安装/加载/Manifest 识别/cordis 插入
- 真实 `ctx.llm.stream`、`ctx.typert.register`、`ctx.remote.$mount` 行为
- 真实插槽渲染位置、宿主 hooks 实际形态、设置页集成、locale 注入
- 与原插件实际同装
- dshmarket 一键更新端到端

缓解依据：全部宿主接口用法逐行继承自可运行的 dsh-suggestion-chips v0.4.12（同 engines 区间），Manifest/package/描述符结构逐字段同构。

## 6. 结论

- 本地可验证部分：**50 项宿主断言 + 7 阶段渲染冒烟全部通过**，构建可重复、产物结构正确（npm pack 12 个文件，40KB）；
- 真实宿主部分：**待安装验证**，已在 README/已知问题中如实标注。
