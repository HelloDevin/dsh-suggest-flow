# dsh-suggest-flow

**Smart Suggestion Plugin for DSH** · 面向 [DSH](https://github.com/deepseek-ai)（DeepSeek Harness 0.2.x）的轻量级 AI 智能建议追问插件。

AI 回复结束后，在**输入框上方**给出几条智能追问 chips，按三个意图方向组织，越用越懂你：

- **🔵 Explore 深入探索** —— 追问当前回答的原理、机制与细节
- **🟣 Expand 横向扩展** —— 相关知识、替代方案、对比与边界
- **🟢 Apply 实际应用** —— 把内容转化为可执行的代码、命令或操作步骤

每轮按对话类型动态选方向（知识问答→Explore；代码开发→Explore+Apply；方案设计→三者均可；简单确认→宁可不发），每条建议目的不同、可直接发送；不合适时宁可不出现。

## 功能

- **智能方向建议**：一次辅助模型调用同时完成意图判断 + 方向选择 + 生成，输出结构化 `{文本, 方向}`，chip 前的方向圆点一眼可辨
- **一键换一组**：点行尾 ⟳ 立即换一组建议——自动避开本轮已经展示过的所有内容；6 秒冷却 + 每轮 5 次上限；失败静默保留原组
- **本地质量过滤**：空内容/超长/重复/同义碎片/重复用户已问/客套话填充，全部本地规则拦截，不增加任何 AI 调用
- **采纳记忆**：本地记录你对建议的采纳与忽略，并统计方向偏好（常采纳"实际应用"就多给可落地的建议），反馈进生成提示词——少量反馈不会导致策略突变
- **单击** chip 填入输入框（可继续编辑），**双击**直接发送（设置页可关）
- **键盘流**（可关）：↑ 激活、←→↑↓ 二维移动、Enter 填入、Ctrl+Enter 发送、Esc 退出；开始打字自动隐藏整行（chip 填入不算打字）
- **重开会话秒恢复**：建议与反馈持久化在 `~/.dsh/storages/dsh-suggest-flow/memory.json`（仅本机，400 条/30 天）——缓存命中不出模型调用
- **成本恒定**：上下文只取最近几轮并折叠代码块，超长对话的生成成本也是常数；DeepSeek 自动关闭深度思考
- **DSH 设置页集成**：启用、条数上限(1-4)、双击发送、打字隐藏、键盘、清空记忆，改动即时生效；内置版本检查与一键更新
- **从旧插件平滑迁移**：首次运行自动（一次性、只读）导入 [dsh-suggestion-chips](https://github.com/HelloDevin/dsh-suggestion-chips) 的采纳历史；两插件也可同时安装、互不干扰

## 安装（desktop 桌面版）

```sh
dsh plugin --profile desktop add https://github.com/HelloDevin/dsh-suggest-flow/releases/latest/download/dsh-suggest-flow.tgz
```

装完后**完全退出并重启 DSH Desktop**。开发调试也可以直接装目录：`dsh plugin --profile desktop add <本目录绝对路径>`（pnpm 会以 link 方式链接，迭代方便）。

插件发布新版本后，**重新执行上面同一条命令**即可完成更新（永久链接，始终指向最新版）。

## 启用

插件默认启用（总开关 `enabled: true`）。如果 chips 没有出现：

1. 确认已完全重启 DSH（托盘退出再启动）；
2. 打开 DSH 设置页 → **智能追问 Suggest Flow** 分区 → 确认"启用智能追问"已打开；
3. 建议只在**一轮回答结束且输入框空闲**时出现，生成中/编辑旧消息时不会出现。

## 配置模型

默认**跟随当前会话的 provider/model**（DeepSeek 自动关闭深度思考）。如需固定辅助模型，在 profile 的 `cordis.patch.yml`（或 overlay）中覆盖：

```yaml
- insert:
    - id: suggest-flow
      name: dsh-suggest-flow
      config:
        provider: deepseek        # 可选：显式指定辅助调用 provider
        model: deepseek-chat      # 可选：显式指定辅助调用 model
```

## 全部配置键

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` * | `true` | 总开关；关闭后不再调用辅助模型 |
| `doubleClickSend` * | `true` | 双击直接发送；`false` 时双击仅填入 |
| `hideWhenTyping` * | `true` | 草稿非空时隐藏整行 chips |
| `keyboard` * | `true` | 键盘快捷键（↑ 激活、←→↑↓ 移动、Enter 填入、Ctrl+Enter 发送） |
| `count` * | `3` | 每轮建议条数上限，1-4；模型按对话动态给出 0~N 条，N 只是上限 |
| `contextTurns` | `3` | 参与生成的最近对话轮数，1-4（最新一轮完整、历史轮减半压缩） |
| `timeoutMs` | `20000` | 辅助调用超时，1000-60000 |
| `provider` / `model` | 未设置 | 可选：显式指定辅助调用 provider/model；省略时跟随当前会话模型 |

带 * 的键也可在设置页修改（设置页的值持久化到 `settings.json` 且优先生效）。

## 使用

| 操作 | 效果 |
|---|---|
| 单击 chip | 文本填入输入框（替换当前草稿），可继续编辑 |
| 双击同一 chip（300ms 内） | 填入并直接发送 |
| ⟳ 按钮 | 换一组建议（避开已展示过的；6s 冷却） |
| ↑ | 激活键盘选择 |
| ←→↑↓ | 二维移动选择（跨行循环） |
| Enter | 填入高亮 chip；草稿已是该 chip 时再按 = 确认发送 |
| Ctrl+Enter | 直接发送高亮 chip |
| Esc / 输入字符 | 退出键盘选择 |
| 悬停 chip | 显示完整建议文本（圆点显示方向名） |

## 更新

设置页"版本"区块：打开即自动检查，展示「可更新到 x.y.z」与版本列表（最近 5 条，含发布日期、latest / 已安装标记）；点「更新」一键升级。也可以随时用安装命令重装最新版。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-suggest-flow
```

或桌面端"插件"页移除，然后重启 DSH。本地数据在 `~/.dsh/storages/dsh-suggest-flow/`，可一并手动删除。

## 许可

[MIT](LICENSE)
