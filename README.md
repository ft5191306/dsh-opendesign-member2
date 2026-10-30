# dsh-opendesign-plugin

一个可开关的 DSH 插件。**插件开启时**，Open Design 的六个预设出现在预设列表里，同时团队 Lead 获得
`design_delegate` 工具和一套设计派单规范；**插件关闭时**，这三样东西一起消失，预设列表恢复成内置的五个。

## 它解决什么

`opendesign` 预设本来就会做前端设计。它缺的是「让别人知道它存在、以及该怎么向它提需求」这层能力。
这个插件补的正是这层，而且刻意做成**同一个开关**：预设声明就写在这个 bundle 的 patch 里，
所以关掉插件不会留下「预设还在、但没人会用」的半吊子状态。

## 装了什么

| 组成 | 作用 |
|---|---|
| 6 个 preset 声明 | `opendesign` / `-prototype` / `-ppt` / `-marketing` / `-hyperframes` / `-motion-design` |
| Host 插件行 | 注册 `design_delegate` 工具，并注入设计派单规范 |
| `locale/zh.json`、`locale/en.json` | 插件管理页显示的中英文标题与描述 |
| `icon.svg` | 插件图标（手机轮廓，对应设计原型） |

## `design_delegate` 怎么用

```
design_delegate({ brief, mode, preset, alignment_rounds, cwd })
```

- `brief` — **主观描述**：这东西是给谁用的、要什么感觉、必须达到什么目的。
- `mode` — `align`（只对齐，不写文件）或 `build`（开始产出）。
- `preset` — 六个设计预设之一，默认 `opendesign`。
- `alignment_rounds` — 实际发生过几轮对齐。**`build` 时必填且 ≥ 1**。
- `cwd` — 设计产出写进哪个目录，每个产物给一个独立目录。

工具会拒绝两种情况，这是设计意图而非限制：

- **`brief` 少于 40 字符**：说明你只发了一个标题，指望设计者去猜。
- **`build` 但 `alignment_rounds` 为 0**：说明跳过了对齐。

对齐 1–3 轮是正常范围。超过 3 轮就是在拖，要么动手，要么直接问用户。

## `design_reply` —— 怎么回话给设计代理

```
design_reply({ subagent_id, message })
```

这个 profile 里 `send_message` 被 Agent Teams 独占（只认 Team 成员名），所以
`send_message({ target: "<设计子代理 id>" })` 会报 `TEAM_MEMBER_NOT_FOUND`。
`design_reply` 补上缺的这半边：直调 `ctx.subagents.sendMessage()`，不经过 Team 名册，
也不需要重新启用任何被 Team profile 停用的行。

- 只接受**本会话里由 `design_delegate` 起的**子代理。判定读会话日志里的
  `label`（`design: <preset>`）与 `mode: continuable`，不依赖插件内存，
  所以重装插件、重启应用之后旧代理仍然可以寻址。
- 对方**已经结束也能发**：服务会从会话日志冷复原它，接着原来的上下文继续。
- 返回的是**投递确认**，不是回答；结果仍旧通过正常通道回报。

细节与实测记录见 `DESIGN-REPLY.md`。

## 派单规范（注入到 prompt）

插件启用后，模型看到的是这样一份规范：

- **所有前端设计类工作都交给它。** 自己不做，也不交给普通队友——普通队友跑的是你自己的预设，
  里面没有设计技能、没有设备外壳、没有设计人格。
- **先对齐再动手。** 第一轮是 `align`，把理解说回去让设计者确认或纠正，用户的答复传回来之后才 `build`。
- **只描述意图，不提具体规范。** 要主观词汇（克制、密实、活泼、安静、编辑感、干一点、笃定），
  不要颜色、字号、间距、圆角、阴影、动画时长、栅格、组件 API。
- **但三类东西要说清楚**：接口契约（数据形状、函数签名、事件名、状态机状态）、
  内联集成（要塞进哪个文件、挂载点、替换哪个元素）、硬规格（目标设备、无障碍等级、文件格式、体积上限、必须的文案）。
  这些是对工作的约束，不是审美选择。
- **一次一个产物。** 原型和它的幻灯片是两次调用，各自独立的 `cwd`。

## 为什么不只是「在 prompt 里写一句去委派」

因为这个项目刚修完的 marker bug 就是这个形状：随附的 Open Design 文本承诺了一个并不存在的 host turn loop，
模型就编了一个 key 等着。**用文字承诺一个不存在的机制，得到的是编造，不是谨慎。**

具体到这次：Agent Teams 的 `spawn_teammate` 参数只有 `name`/`description`/`prompt`/`context`，
`agent-team` 包里从头到尾没有 `agentPreset`。所以「让队友去做设计」不可能真的得到一个 Open Design agent——
那个队友跑的是 Lead 自己的预设。而普通 subagent 通路可以：它把 `agentPreset` 一路传到 `presets.mount()`，
`spawn` provider 也声明了 `capabilities.agentPreset = true`。

所以这个能力被做成一个真正能调用的工具，而规范描述的是这个真实存在的工具。
工具在 Host 级注册，**团队 Lead 和普通 agent 都拿得到**，符合「插件开启即可用」。

## 踩过的坑（都在代码注释里留了记录）

**1. `inject` 只接受数组。** Cordis 的 `Inject.resolve` 把数组转成 `{name: null}`，
其他形状则逐键当作服务名。写成 `{ required: [...], optional: [...] }` 会被读成两个叫
"required" 和 "optional" 的服务，插件永远等不到、永不激活。所以这里是四个硬依赖的数组。

**2. `tools.register` 要真 JSON Schema。** 官方工具用「属性级 `required: true`」的紧凑写法，
但那是由 `defineTool` 编译成对象级 `required` 数组的。直接 `register` 紧凑写法，就把
`"required": true` 放在了 `string` 节点上，provider 在请求阶段用 `anyOf` 校验打回，
**整轮失败、任何工具都调不了**。这里直接写合法 JSON Schema，也就不依赖 `dsh-tools`——
profile 链接安装的包根本解析不到它。

**3. 一个 preset id 只能声明一次。** 旧 bundle 和新插件同时声明 `preset-opendesign*` 会让两边都被停用。
迁移时必须先把旧的移除，所以旧 bundle 已从 profile 里删掉，预设声明现在唯一来源是这里。

**4. 预设行不能是相对路径。** 详细原因见 `../dsh-opendesign-preset/PRESET.md` §3a：
relative `name:` 会按 profile 根解析而失败，整个预设变成加载失败。

## 重新生成 patch

`cordis.patch.yml` 是生成的，不要手改：

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node "$PSScriptRoot\tools\build-plugin-patch.mjs"
```

它从 `~/.dsh/presets/opendesign/cordis.patch.yml` 逐行搬运六个预设声明（保留 470 KB 提示词原文的每一个字节），
并自校验搬运前后内容哈希一致；不一致就报错而不是写出半份 patch。

## 目录

```
dsh-opendesign-plugin/
├─ package.json              # @local/dsh-opendesign-plugin, dsh.bundle.patch
├─ cordis.patch.yml          # GENERATED：Host 行 + 6 个预设声明
├─ index.js                  # design_delegate + design_reply + 派单规范
├─ od-frames.mjs             # .od-frames 暂存行（预设内联引用它）
├─ assets/frames/            # od-frames 的随附载荷（5 个文件 + SOURCES.json）
├─ DESIGN-REPLY.md           # design_reply 的实现说明与实测记录
├─ icon.svg
├─ locale/{zh,en}.json
└─ tools/build-plugin-patch.mjs
```

## 自包含

这个包**不依赖 `~/.dsh/presets/opendesign/`**，可以独立安装到任何 profile：

| 依赖项 | 以前 | 现在 |
|---|---|---|
| `od-frames` 模块 | `file:///C:/Users/Administrator/.dsh/presets/opendesign/plugin/od-frames.mjs`（6 处绝对路径） | `@local/dsh-opendesign-plugin/od-frames`（包名子路径，6 处） |
| `od-frames` 载荷 | `~/.dsh/presets/opendesign/assets/frames/` | 包内 `assets/frames/` |
| 预设声明 | 从预设包 patch 逐行搬运 | 同左（生成时搬运，产物在包内） |

实现要点：预设行**不能**用相对 `name:`。它按 profile 根解析，`./plugin/x.mjs` 会变成
`profiles/desktop/plugin/x.mjs`，导入失败会**整个预设掉线**。裸包名则走 Node 的模块解析，
profile 的 `node_modules` 里有本包，所以 `@local/dsh-opendesign-plugin/od-frames` 在任何机器上都成立。

`tools/build-plugin-patch.mjs` 里 `OD_FRAMES_SPECIFIER` 是唯一控制点；生成时会校验
必须改写满 6 处，少一处就报错而不是静默少改。

### 重新生成 patch

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node tools\build-plugin-patch.mjs
```

Node 在本环境可能写不了文件（`EPERM`，即使是 pwsh 能写的路径）。此时用：

```powershell
& $node tools\build-plugin-patch.mjs --stdout 1> cordis.patch.yml
```

进度信息走 stderr，stdout 只有 patch 正文，可直接重定向。

## 版本漂移防护

这个包里有**两处外来内容**，都会在源升级后静默过期：

| 内容 | 来源 | 过期的症状 |
|---|---|---|
| `assets/frames/`（5 个文件） | Open Design 安装目录 | 设计者拿到过期的设备外壳与布局基元，没人报错 |
| `cordis.patch.yml` 里 ~470 KB 提示词正文 | 同级 `dsh-opendesign-preset` 包 | 预设行为与上游不一致 |

它还依赖一组**具体的 DSH 行为**（Loader 怎么解析预设行 `name:`、`tools.register` 的 schema 契约、
`subagents` 的冷复原语义……）。这些也会变，而且变坏时同样不报错。

### 检查

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node tools\verify-bundle.mjs            # 外部依赖缺失时 warn，仍 exit 0
& $node tools\verify-bundle.mjs --strict   # 缺失即失败，用于发布闸门
```

四组共 17 项：

1. **载荷完整性** —— 每个文件存在、非空、匹配 `SOURCES.json` 记录的 sha256
2. **对 OD 的保真** —— 4 个静态外壳与已装 OD 原件逐字节相同；`deck-framework.md` 从 OD 自己的
   daemon chunk 重渲染后**字节一致**（不是"看起来对"）
3. **行与包** —— 6 个预设行都用包名子路径；该 specifier 能从 profile 模块根解析到本包并加载出
   Cordis 契约；patch 内无绝对 `file:` URL；其余字节与预设包 patch 逐行一致
4. **DSH 契约** —— 见 `host-contracts.json`

`host-contracts.json` 逐条记录本包依赖的 9 个 DSH 行为：每条写明**依赖什么**、**变坏会怎样**、
**怎么验**。理由很实际：`tools.register` 的 schema 契约一变，整个会话的每次工具调用都会在请求
阶段失败；预设行解析规则一变，六个预设全部变成"加载失败"徽章。这两类故障都不会说"是因为插件"。
写下来，升级时可以对照 diff，而不是靠回忆。

### 检测器不会空转

实测过：给 `iphone.html` 末尾加 14 个字节，两条独立检查同时报错——

```
FAIL iphone.html size drifted: 8925 != recorded 8911
FAIL vendored frames drifted from the installed OD originals: iphone.html. Re-run the preset
     package's tools/stage-frames.mjs, then copy assets/frames/ here and refresh SOURCES.json.
```

恢复后立刻回绿。报告给的是**修复动作**，不只是错误。

## 已验证的行为

| 检查 | 结果 |
|---|---|
| 插件启用 → 预设列表含 6 个 opendesign | ✅ |
| 插件启用 → `design_delegate` 出现在工具列表且 schema 合法 | ✅ |
| 插件关闭 → 6 个预设全部消失，只剩 5 个内置 | ✅ |
| 插件关闭 → Host 行不再存在 | ✅ |
| `build-plugin-patch.mjs` 确定性 + 内容哈希一致 | ✅ |
| **端到端：`design_delegate` 真的起出设计子代理** | ✅ 子会话 `agentPreset: opendesign`，`delegationDepth: 1` |
| **端到端：`cwd` 里真的产出文件** | ✅ 87–101 KB 的 `index.html`，四屏可交互 |
| **对齐闸门** | ✅ 跳过对齐的 `build` 被拒 |
| **主观 brief 不下规格也能推进** | ✅ 设计者主动给出主观方向并只问 3 个开放问题 |
| **`design_reply` 双向通道（含冷复原、跨重装）** | ✅ 见 `DESIGN-REPLY.md` |
| **自包含：不依赖 `~/.dsh/presets/opendesign/`** | ✅ patch 内 0 处绝对路径；`od-frames` 走包名子路径；载荷随包 |
| **版本漂移防护（OD + DSH 双源）** | ✅ `tools/verify-bundle.mjs` 17 项全过；注入 14 字节漂移即报错 |

### 一个已知的行为细节

`align` 轮虽然被要求「不写文件」，但 opendesign 预设仍会在 `cwd` 里落下 `.od-frames/`
设备外壳（`iphone.html` / `android.html` / `neutral.html` / `layout.css`）。这是预设自带的
资源脚手架，不是设计产物；`index.html` 才是。给每个 delegate 独立 `cwd` 可以避免它们混在一起。
