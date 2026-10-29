# `design_reply` 实现说明（已实测通过）

日期：2026-10-29 · 本机实测 · 插件已装并启用

## 它解决什么

`design_delegate` 起的设计子代理只能「子报父」，Lead 回不了话。在这个 profile 里
`send_message` 被 Agent Teams 独占（只认 Team 成员名），所以：

```
send_message({ target: "<设计子代理 id>" })   → TEAM_MEMBER_NOT_FOUND
```

`design_reply` 补上缺的那半边，且**只对 design_delegate 起过的子代理有效**。

## 契约

```js
design_reply({ subagent_id, message })  // → { subagentId, messageId }
```

- 投递是**确认送达**，不是拿到回答；子代理仍旧通过正常通道回报。
- 子代理已经结束也能发——`sendMessage` 会从会话日志**冷复原**它，继续原来的上下文。

## 关键实现选择

### 1. 直调 `ctx.subagents.sendMessage()`

不经过 Team 名册，因此不需要重新启用任何被 Team profile 停用的行
（`tool-subagent-control` 保持 `disabled: true`），也不需要碰
`@deepseek-ai/dsh-experimental-tool-agent-team`。

### 2. 工具名不叫 `send_message`

`dsh-tools` 的 `NamedEntries` 对同名工具是**硬冲突**：

```
tool "${name}" is already registered
```

所以必须另起名字。选 `design_reply` 而不是 `send_message2`，是为了让模型一眼看出
它只服务于设计代理。

### 3. 所有权校验读会话日志，不存内存

第一版用 `new Set()` 记子代理 id——**这是错的**，重装插件或重启应用后集合清空，
之前所有设计代理就永久失联，冷复原能力等于作废。

现在改为读 `subagents.listChildren(parent.id)`，对目标做三条校验：

| 条件 | 拒绝理由 |
|---|---|
| 不在本会话直系子代理目录里 | `is not a child of this session` |
| `mode !== 'continuable'` | 不可复原，发不过去 |
| `label` 不以 `design: ` 开头 | 是队友或其他子代理，不是设计代理 |

`label` 由 `design_delegate` 自己写死成 `design: <preset>`（`DESIGN_LABEL_PREFIX`），
模型无法伪造，所以它足以作为所有权证明。

### 4. 服务用 `requireService(ctx, ...)`

Cordis 的 `inject` 是数组形式，服务经 `ctx.get()` 取得；写成 `ctx.subagents`
是拿不到的（本轮踩到过一次，报 `Cannot read properties of undefined`）。

## 实测证据

| # | 场景 | 结果 |
|---|---|---|
| 1 | 子代理运行中回话 | ✅ 首次实测 `REPLY-OK-1` |
| 2 | **子代理结束后**再回话（冷复原） | ✅ 唤醒成功，`REPLY-OK-1` 回流 |
| 3 | **插件 remove+install 重装之后**再回话 | ✅ `REPLY-OK-2` 成功，证明校验不依赖内存 |
| 4 | 非本插件子代理 id | ✅ 拒绝 |
| 5 | Team 成员 id | ✅ 拒绝，并提示改用 `send_message` |
| 6 | 不存在的 id | ✅ 拒绝 |
| 7 | 空 message | ✅ 拒绝 |
| 8 | 无所属 agent | ✅ 拒绝 |

第 3 条是关键：重装插件会重新求值 `index.js`、清空模块内存，此时旧子代理仍可寻址，
说明持久化设计成立。

## 仍然存在的限制（诚实列出）

1. **仅限本会话直系子代理**。跨会话（重启后新会话的 Lead）不能寻址旧设计代理，
   因为 `listChildren` 只列当前 parent 的目录。
2. **`messageId` 是投递凭据，不是回答**。要拿结果必须等子代理回报。
3. **未完成的子代理被中断时，到达父代理的是被截断的收尾消息**。
   这不是延迟：子代理若在生成途中被停，它没机会调用 `send_message`，
   服务只能把它已提交的部分文本作为 closing message 转过来。
4. **投递是实时的，但父代理只在「下一个 step 边界」看见它**。
   一次工具调用占满整个 step，期间到达的消息进 inbox 但不进入模型视野。
   所以 **Lead 不能用长 `Start-Sleep` 轮询**——那等于自己把消息挡在 step 外面。
   （本节早先写成「回合内保活仍需要 Lead 自己等」，那是错的，已更正。）

## 实测延迟（2026-10-29，三轮对话）

| 方向 | 实测 |
|---|---|
| 父 → 子（`design_reply` 收到 → 子 turn/start） | **35 ms / 43 ms** |
| 子 → 父（子文本落地 → 父 inbox） | 取决于父是否卡在工具调用里 |

子代理侧回答耗时：第 1 轮 13 s，第 3 轮 8.4 s（第 2 轮被用户中途停掉）。

父代理侧观察到的「慢」全部可归因于自己插的 sleep：

| 轮 | 子代理产出时刻 | 父代理看见时刻 | 差值 | 原因 |
|---|---|---|---|---|
| 1 | 21:16:47.390 | 21:18:35.801 | 108 s | 父在跑 65 s 的 `Start-Sleep` |
| 2 | 21:18:50.588 | 21:19:30.163 | 40 s | 父在跑 34 s 的 `Start-Sleep` |
| 3 | 21:19:49.566 | 21:20:26.197 | 37 s | 父在跑 40 s 的 `Start-Sleep` |

结论：**通道不慢，是轮询慢**。正确做法是发完就继续做别的事，让消息在下一个 step
自然到达；不要用 sleep 去「等」。

## 回归检查清单

改这个插件后至少跑一遍：

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --check 'C:\Users\Administrator\Documents\dsh-opendesign-plugin\index.js'
# 然后 remove_bundle + install_bundle，再用 cordis_inspect_query Tool.listTools
# 确认 design_delegate 与 design_reply 都在，且两者 required 都是对象级数组
```
