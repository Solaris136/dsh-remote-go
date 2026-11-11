# 完全会话设计（remote sessions as first-class local sessions）

> **English abstract.** Today the remote DSH is shown as a full-page iframe panel: everything works, but the remote
> sessions never appear in the local sidebar and never use the local Conversation UI. This document designs the next
> step — *complete sessions*: remote sessions become first-class local sessions (listed natively, opened in the normal
> Conversation UI, streamed, and able to carry approvals back), while the plugin keeps its thin-client, zero-remote-
> component posture. It defines the capability levels, the data model, the event channel, the failure modes and a
> phased delivery plan. The rest is written in Chinese.

## 1. 为什么需要这一层

现状（[docs/design.md](design.md) §v0.7 附录，行 529-538）：远端 DSH 在自己的 iframe 面板里整页运行，等价于
「把另一台机器的界面显示出来」。它的问题不是能不能用，而是**不是本地一等公民**：

- 远端会话不出现在本地侧边栏，切会话必须先切主机再在面板里找；
- 远端会话不能进本地 Conversation UI，本地的工作区栏、搜索、快捷键都用不上；
- 两套界面并存（本地一套、iframe 一套），用户要在两套心智模型之间切换。

同类项目的经验（[docs/research-competitors.md](research-competitors.md)）：`Golden-Pigeon/dsh-remote` 用
「local mirror Session + Agent façade」把远端会话镜像成本地原生会话，宣称 “remote sessions appear in the normal
sidebar”；`dsh-remote-gui` 用侧栏入口 + 原生面板列远端会话。两者都**没有**去遮蔽宿主的 `sidebar.workspaces`。

> 关键约束：`sidebar.workspaces` 是单占槽位（由 `dsh-client-ui-workspace` 独占），第三方插件无法向**该槽位**追加分组
> （[docs/design.md](design.md) §v0.7 附录第 3 条的限制说明，行 ~536）。**所以「完全会话」不能靠往宿主侧边栏塞分组
> 实现，只能靠让远端会话本身成为本地会话。**
>
> 补充（后续验证）：宿主另提供可选的 `workspaceRegistry`，插件可注册工作区（`Remote: <主机名>`），让镜像会话在
> 本地侧边栏原生可见。这**不改**上述结论——它仍然是「让远端会话成为本地会话」，只是多了一条被宿主认可的分组途径。
> 见下文 §4.3。

## 2. 目标与非目标

目标：

1. 远端会话出现在**本地原生**侧边栏会话列表里，与本地会话同列（可分组到所属远端主机）。
2. 点开即用**本地原生 Conversation UI** 渲染（不是 iframe）。
3. 支持流式增量、历史回翻、可归档/改名，状态（等待审批/运行中/空闲）与本地会话一致呈现。
4. 保持既有的安全姿态：凭据不出本地、隧道只回环、版本一致、零远端专属组件。

非目标（明确不做）：

- 不在本地重跑一个 Agent（本地不持有模型凭据、不代跑工具）。
- 不做双向并发写：同一会话同时只允许一个写入者（本地或远端），冲突显式拒绝而不是合并。
- 不接管远端 DSH 的插件/设置/文件/终端管理；这些仍在 iframe 面板里完成。

## 3. 核心概念：镜像会话（mirror session）

一个**镜像会话**是本地 DSH 里的一个普通 Session，但它的内容是远端某个 Session 的投影：

| 字段 | 含义 |
|---|---|
| `localSessionId` | 本地会话 id（侧边栏看到的就是它） |
| `hostId` | 所属远端主机（复用现有 host 存储） |
| `remoteSessionId` | 远端会话 id（远端 DSH 的权威 id） |
| `cursor` | 已镜像到的事件序号（`lastSeq`），用于断点续传 |
| `capabilities` | `list` / `history` / `stream` / `input` / `approve`，按探测结果降级 |
| `mirroredAt` | 最后一次成功同步时间（离线时用于「最后已知状态」） |

约定：**远端是唯一事实来源**。本地会话的标题、消息、状态都以远端投影为准；本地只额外保存「未发送的草稿」与
「已读位置」这类本地私有状态，避免写者冲突。

## 4. 能力分级与选型

| 级别 | 能力 | 数据来源 | 用户可见效果 |
|---|---|---|---|
| L1 目录镜像 | 列出远端工作区（标题、路径、会话数）与会话 id/计数 | 远端 `storages/workspace.json`（现有 `src/workspaces.js` 只产出工作区级数据 + sessionIds，不含每会话标题/时间/状态） | 侧边栏能看到远端工作区及其会话数，点开进入 iframe 面板定位到该工作区 |
| L2 只读镜像 | L1 + 历史正文回放 | 远端 `sessions/**/session-*.json[l]`（SSH `exec` 读取，本版已实现） | 本地 Conversation UI 里能读远端历史，只读 |
| L3 完全会话 | L2 + 流式订阅 + 输入转发 + 审批回本地 | 远端 `ws-mux` 事件流（本仓库 E2E 证据已证明隧道内可握手） | 与本地会话几乎无差别：流式、可发消息、审批在本地弹 |

选型：**分阶段做到 L3，但每一级都独立可用**。任何一级失败必须显式降级（例如事件流握手失败 → 停在 L2 并提示
「只读，远端事件流不可用」），不允许静默假装成完全会话。

## 4.1 前提能力（已在本机核实）

设计依赖「插件能以宿主身份创建本地会话」这一能力，已通过 Cordis Inspect 对 `ctx.sessions`（host）核实：

| 能力 | 签名要点 | 对本设计的用途 |
|---|---|---|
| 创建会话 | `create(id?, { seed, meta })` | 建立镜像会话；`seed` 可直接回放远端历史事件 |
| 追加事件 | `Session.append(type, data, intent?)` | 把远端新增事件写入本地镜像会话（surface 事件必须传 intent） |
| 分叉 | `fork(source, boundary?, childId?)` | 从远端某条消息处分叉出本地会话 |
| 元数据 | `meta.cwd` 必须是绝对路径，`meta.parentSession` 记录血缘 | 标记该会话属于哪个远端主机/远端会话 |

**关键约束（必须写进实现）**：`ctx.sessions` 只做内存存储，持久化由 agent 生命周期挂载的 session-log writer 负责——
「a session published outside that lifecycle persists nothing」。镜像会话不走 agent 循环，因此：
要么给它接一个 writer（P2 必须解决），要么接受**重启后重新同步**（P0/P1 可以接受，但要在 UI 上说明「重启后从远端重拉」）。

**`append` 的第三个参数**：surface 事件（`system/message`、`developer/message`、`user/message`、
`assistant/message`、`tool/result`）必须带 `SurfaceIntent`，否则事件只作为普通记录落库、不会被宿主当作会话可见内容
呈现。回放映射固定为 `surfaceOp: 'append'`：

| 远端事件 | 本地写入 |
|---|---|
| `system/message` / `developer/message` / `user/message` / `assistant/message` / `tool/result` | `Session.append(type, data, { surfaceOp: 'append' })` |
| 非 surface 事件（游标、状态等） | `Session.append(type, data)` |

### 4.2 契约变更（docs/api.md）

镜像会话不是纯 UI 变化，需要扩展 Host↔Client 契约（[docs/api.md](api.md)）：

- L1 可复用现有 `GET /hosts/:id/workspaces`（v1 已有），只取工作区级数据与 `sessionIds`。
- L2/L3 需要**新增**接口与字段：镜像会话目录、历史区间拉取、事件流订阅、输入与审批转发；字段如
  `remoteSessionId`、`cursor`、`capabilities`、`mirroredAt`。
- [docs/api.md](api.md) 目前是**冻结的 v1**：上述扩展必须以 v1.1（或 v2）显式版本化新增，先改契约文档、再改两侧
  实现；不得就地改写 v1 已有字段的语义。

### 4.3 侧边栏可见性前提（已在本机核实）

P0 建好镜像会话后侧边栏仍然看不到它们：DSH 的侧边栏**按工作区**列会话，而工作区归属由**会话头的规范化 cwd**
推导，不是 `meta` 里的显式字段。用 Cordis Inspect 对 Host `sessions` / `workspaceRegistry` 核实的结果：

`sessions.create(id?, options?)` 的 `options.meta` 只有
`{ cwd, parentSession, createdAt, isSeeded, origin, delegationDepth, agentPreset }` —— **没有 workspaceId 字段**。

Host `workspaceRegistry`（`ctx.get('workspaceRegistry')`，可选依赖）：

| 方法 | 签名 | 关键语义 |
|---|---|---|
| 创建/复用 | `async create(path: string, title?: string): Promise<Workspace>` | 目录必须存在（`fs.realpath` 规范化）；同一规范化路径重复调用返回既有实体，且**不改标题** |
| 按路径查 | `async resolveByPath(path: string): Promise<Workspace \| undefined>` | 只查不建；已存在但未注册返回 `undefined`，路径不存在时 reject |
| 列表 | `list(): Workspace[]` | 每个实体的 `sessionIds` getter 已按「启动/在线 规范化 cwd 头索引」过滤 |
| 删除 | `async delete(id: WorkspaceId): Promise<boolean>` | 只删注册，保留目录与会话日志；未知 id 幂等 |
| 重命名 | `Workspace.setTitle(title): Promise<void>` | 修改显示标题 |

`Workspace` 另有 `attachSession/detachSession/insertSessionBefore/status`，但**成员关系由 cwd 索引决定**：把每台
主机的镜像目录注册成工作区，P0 的镜像会话就自动归组，不需要逐会话 attach。

实现要点（P0 增补，`src/workspace-adapter.js`）：

- 每台远端主机一个工作区：路径 `$DSH_HOME/remote-go/mirrors/<hostId>`，标题 `Remote: <主机名>`；路径与会话的
  `meta.cwd` 由**同一个** `mirrorHostDir()` 产出，避免两侧漂移。
- 路径规范化：注册表用 `fs.realpath` 规范化注册路径，而会话头保留字面 `meta.cwd`。若镜像根经过符号链接或 Windows
  junction，两者会分叉，分组就依赖「注册表也规范化会话头」这一无法从插件侧验证的假设。因此插件加载时对镜像根做
  `realpath` **直到不动点**（缺失则创建，失败则回退字面路径并告警；单次 `realpath` 在部分卷上不会把 8.3 短名
  归一，故需迭代收敛），**同一个不动点根**同时交给会话适配器与工作区适配器：由于注册表的 `realpath` 对不动点
  是恒等的，两处拼写必然一致。
- 幂等：先 `resolveByPath()` 再 `create()`，重连复用同一注册；主机改名时只在现有标题仍带 `Remote: ` 前缀（即插件
  自己写的）时才 `setTitle()`，用户手工改名不覆盖。上报的 `path` 用注册表返回的规范化路径。
- 关闭即移除：`mirrorToSidebar=false` 时**删除**该主机的注册（幂等），否则「Remote: …」分组会永远留在侧边栏
  ——镜像会话只在内存里，重启后不会有会话把它填回来。重新开启后在下一次同步重建。
- 清理：删除主机时 `delete()` 该注册（保留目录，重连可重建）。删除失败不能留下「没有主机、永远空」的幽灵分组，
  所以 `init()` 会对镜像根下**直接子目录**做一次孤儿清理：没有对应主机记录的注册一律删除（只删注册，绝不删目录，
  根外注册不参与）。清理失败只告警，不阻塞加载。
- 降级：`workspaceRegistry` 缺失（含 `ctx.get()` 抛错）、`sessions` 缺失、本次同步所有 `sessions.create` 都失败、
  路径不存在或注册失败 → 记录日志并降级（`sessions-unavailable` 等类型化原因），**绝不把异常抛进连接流程**，也
  不会注册一个 `sessionIds` 为空的空分组。

## 5. 数据通路

```text
本地 DSH（Host 插件）
├─ 镜像会话存储（本地 Session 记录 + cursor + capabilities）
├─ 侧边栏工作区注册（每台主机一个 workspace，路径 = 镜像 cwd）   ← P0 增补
├─ SSH（ssh2）：认证 / exec / forwardOut          ← 已有
├─ 隧道：127.0.0.1:<localPort> ──▶ 远端 127.0.0.1:<remotePort>   ← 已有
└─ 远端会话适配器（L1/L2 已实现）
   ├─ 目录：读远端 storages/workspace.json                      ← L1
   ├─ 历史：读远端 sessions/**/session-*.json[l]（SSH exec）     ← L2（本版）
   ├─ 流式：ws-mux 订阅（增量事件 → 追加到本地镜像会话）          ← L3 未实现
   └─ 写入：本地输入 → 远端 RPC（单写者仲裁）                     ← L3 未实现

远端服务器：原版 DSH（不装任何专属组件）
```

镜像会话能不能出现在侧边栏，取决于「工作区注册」这一行：DSH 的侧边栏按工作区列会话，而工作区成员由会话头的
规范化 cwd 决定（§4.3）。镜像目录与会话 `meta.cwd` 必须完全一致，因此两者共用一个路径函数。

设计取舍：**不引入远端 agent**。远端就是原版 DSH，镜像所需的目录与历史都走它**已经在磁盘上的文件**（SSH `exec`
读取，L1 读 `storages/workspace.json`、L2 读 `sessions/**/session-*.json[l]`），事件流与输入转发预留给 L3 的既有
接口；这是本项目相对 `Golden-Pigeon/dsh-remote`（需装 `dsh-remote-agent`）的主要差异，也是「零远端专属组件」
承诺的延续。

## 6. 事件流与游标

- 每个镜像会话持有单调递增 `cursor`（远端事件序号）。本地只追加 `seq > cursor` 的事件，天然幂等。
- 重连：从 `cursor` 续传；远端若已丢弃该区间事件，则降级为「重新拉全量快照 + 重置 cursor」并提示用户。
- 单写者仲裁：本地持有「写入租约」（心跳续约）。租约过期或远端检测到第二个写入者时，本地转为只读并提示，
  绝不并发写。
- 上限：镜像事件数受 `mirrorMaxEvents` 限制（默认 200，`0` = 不限）。超限时保留**最新** N 条，并在会话里先写一条
  `mirror/history-folded` 通知（带 `folded` / `retained`），然后从新窗口起点继续。

### 6.1 L2 已落地（历史回放）

`cursor` / `applyEvents` / `nextCursor` 从「纯函数」变成**生产在跑**的路径（`src/history.js` +
`src/service.js#syncMirrorHistory`）：

| 环节 | 实现 |
|---|---|
| 远端发现 | SSH `exec`：`test -d <DSH_HOME>/sessions` → `find … -maxdepth 4 -type f -name '*<remoteSessionId>*' \| head -n 5` → `head -c <maxBytes> <file>`，全部单引号转义、带超时 |
| 解析 | JSON 数组 / `{events\|records\|messages\|history\|turns:[...]}` / JSONL；显式 `version != 1` 直接判 `unknown-version`，不猜 |
| 映射 | `{ seq, type, data, at }`，`seq` 单调；缺 `seq` 时用 1 起的位置 |
| 应用 | `applyEvents({ cursor, events: [] }, window)`：只应用 `seq > cursor`，输入顺序无关，重复 `seq` 取首个 |
| 缺口 | 游标停在缺口前最后一个连续事件；随后按 §6 的「重置游标 + 全量重拉」恢复一次，仍不连续才判 `gap-unfilled` |
| 去重 | 写入本地会话的事件带 `data.mirrorSeq`，append 前再与「会话里已有的 seq」比对（真机走 `snapshotEvents()`），覆盖「append 成功但 cursor 未落盘」的窗口 |
| 保留 | `mirrorMaxEvents`（默认 200）截断为最新窗口；首次同步折叠前缀并写 `mirror/history-folded`（带真实的 `from`/`to`），之后溢出按缺口处理 |
| 只读标识 | 每个镜像会话首次回放时写一条 `mirror/read-only`（非 surface），descriptor 同时带 `readOnly: true`，客户端据此标注「只读」 |

**什么被保留**：角色/类型、正文文本（`text` 或 `content` 的文本段）、工具调用的名称 + 参数摘要（≤200 字符）+
`toolCallId`、`isError`、时间戳。

**什么被丢弃**：二进制/内联附件（`data:` base64 直接替换为 `[binary omitted]`）、非文本 content 段、
模型内部字段（`logprobs` / `usage` / `raw` / `embeddings` / `providerMetadata` 等）、以及任何未识别的匿名记录
（无 `type`、无 `role`、无正文的对象）。

**未知类型**：带 `type` 但本插件不认识的记录**保留**为 `{ seq, type, data: { record: <投影> } }`，投影有确定的
深度/键数/字符串上限，因此同一输入永远得到同一事件；这样远端升级不会表现为「数据消失」。

### 6.2 L3 前置：租约 epoch 与围栏（已落地）

L3（流式事件、输入转发、审批回传）之前必须先有「旧写入者不会再写」的机械保证，否则分区归来的写入者会与
新写入者交错写同一份镜像（split brain）。这一层现在已实现（`src/mirror.js` 的租约函数 + `src/lease.js` +
`src/service.js#syncMirrorHistory`），L3 只需在此之上加通道，不需要重新发明仲裁。

**状态机**（每个 mirror 独立）：

```
                 acquire(发放新 epoch)
   (none) ───────────────────────────────▶ acquired ──renew(epoch 不变)──▶ renewed
      ▲                                        │                             │
      │                                        │ expiresAt <= now            │ 看到更高 epoch
      │                                        ▼                             ▼
      └────────────── expire ◀────────────  expired ◀─────────────────── fenced
                                                 │
                                                 └── acquire(epoch+1) ──▶ acquired（恢复）
```

| 状态 | 含义 | 还能写吗 |
|---|---|---|
| `acquired` | 刚拿到租约，`epoch` 已发放 | 能 |
| `renewed` | 心跳续约，**epoch 不变**（同一份授权，自己的在途写不能被自己作废） | 能 |
| `expired` | `expiresAt <= now`，租约已失效 | 不能（`lease-expired`） |
| `fenced` | 看到比自己更新的 `epoch`，或同 epoch 但写入者不同 | 不能（`stale-epoch`），且租约被清空 |

**谁持有什么**：

- 远端（或 L3 落地后的控制通道）发布 `<DSH_HOME>/remote-go/lease.json`：`{ writer, epoch, expiresAt }`。
  这是**可选**的：文件不存在表示「没有竞争写入者」，本地照常持有自己的租约；文件损坏（`lease-malformed`）
  则表示「权威不可信」，同样不当作「没人写」。
- 本地在 descriptor 里持久化 `epoch`（高水位）、`lease`（`owner/acquiredAt/renewedAt/expiresAt/epoch`）、
  `fencedEpoch` / `fencedWriter`（去重用）。
- **高水位属于 descriptor，不属于租约**：租约过期或被释放后 `epoch` 不会回退，所以旧写入者即使重新连上、
  甚至重启，也拿不到一个已经用过的号码。

**围栏规则**：

1. 每个 descriptor 的**写入批次之前**跑两次 `assertWritable(state, {owner, epoch, now})`：一次在两次带超时的 SSH
   读之前（避免白读），一次**紧贴 append 之前**（纯函数、无 I/O，且重新读注入时钟）。后者是必需的：两次读各可
   长达 20 s，而默认 TTL 是 30 s，慢同步可能活过自己的租约。`epoch < 高水位` 直接拒绝（`stale-epoch`）。
   这是唯一能挡住「租约看起来还有效、但自己已经被接管」的检查。
2. 呈现**更高** `epoch` 的写入者被接受，并抬高本地高水位（号码即事实）；呈现更低者一律拒绝。
3. 一次围栏事件只在**同一个 epoch 的第一次**被判定为 `changed`，因此每个会话每次围栏只写一条
   `mirror/fenced` 非 surface 通知，不会每次同步刷屏。
4. 被围栏时：不写、不推进 `cursor`、丢弃自己的租约、descriptor 标 `readOnly: true` + `reason.code = "fenced"`，
   已有历史**原样保留**（只读可看）。
5. 恢复：竞争消失后重新 `acquire` 会拿到 `epoch + 1`，从原 `cursor` 继续——历史不会重拉、不会丢。
6. `#ensureMirrorSessions`（创建本地镜像会话）**有意不经过围栏**：它只创建本地 DSH 会话、不写远端、也不追加
   镜像历史，被围栏的客户端仍然可以「看到」会话列表。围栏管的是**写入远端历史投影**这件事，不是本地可见性。

时钟是**注入**的（`RemoteGoService` 的 `clock`），所以过期与围栏由测试推进假时钟验证，不靠真实等待。

**围栏的适用边界（重要，别把 L3 建在错的假设上）**

今天的保证只覆盖**共享同一描述符存储（`mirrors.json`）的写入者**：同一本地 profile 的重启、并发同步，以及
远端 `lease.json` 所声明的第三方。

**两个互不相识的客户端不会被定序**：它们各自有一个 `mirrors.json`，都从 `epoch 0` 起步，都会拿到 `epoch 1`，
也都能通过自己的 `assertWritable`——谁也不会看到对方的号码。而且插件目前**只读**远端权威，从不发布自己的
`{ writer, epoch, expiresAt }`，所以远端也无从拒绝一个过期 epoch。换句话说，现在这套东西是**单机内的
重复写入防护 + 一个可观测/可拒绝的远端声明**，不是分布式互斥。

L3 必须补齐的前提（缺一不可）：

1. **双向权威通道**：本地要主动**发布**自己的 `{ writer, epoch, expiresAt }`，而不是只读别人的。
2. **远端侧拒绝过期 epoch**：写入请求带 epoch，远端按自己的高水位拒绝落后的一方（今天的检查只在本机）。
3. **真实性绑定**：否则第三方只要发布一个巨大 epoch 就能把真正的所有者围栏掉（现在的棘轮会立刻接受更高号码，
   等于一个廉价的 DoS）。
4. **逐次写检查**：现在是「每批之前」检查；真正并发下应做到每次 append 前检查（或由远端原子地校验）。
5. **两主机 + 分区测试**：需要两个客户端连同一远端会话、并让其中一个真的断网再回来，才能验证时序竞争。

## 7. 生命周期与失败模式

| 场景 | 期望行为 |
|---|---|
| 主机未连接 | 侧边栏仍显示会话（来自上次快照），标记「离线」，点开显示最后已知状态 + 重连 |
| 版本不一致 | 不建立镜像，降级 L1，并在会话上标注版本不匹配（沿用现有版本一致策略） |
| 远端会话被删除 | 本地镜像会话标记为「远端已删除」，仅保留只读快照，不自动删除本地记录 |
| 隧道中断 | 会话转只读，自动重连（沿用现有 autoReconnect），恢复后从 `cursor` 续传 |
| 事件乱序/重复 | 按 `seq` 去重排序；`seq` 缺口 → 触发区间补齐 |
| 本地归档 | 只归档本地记录，不归档远端（显式区分，避免误删远端数据） |

## 8. 安全边界（在现有基础上新增）

- 镜像只读远端**自己的**数据；凭据、令牌仍只在本地内存（可选 0600 落盘），不写入镜像记录。
- 隧道与远端界面仍只绑 `127.0.0.1`；镜像不新增任何监听地址。
- 审批回本地时必须带主机与远端会话 id，本地展示「你正在批准远端主机 X 上的操作」，避免误批。
- 镜像内容可能含远端敏感文本：本地落盘沿用现有 0700/0600 与原子写，诊断导出继续脱敏。

## 9. 与现有界面的关系

- **保留** iframe 面板：作为「完整远端界面」入口（文件树、终端、插件管理、远端设置都在里面），也是 L3 出问题时的
  逃生通道。
- **设置 → 远程主机** 不变。设置新增「镜像会话」分组里的 `mirrorToSidebar`（默认开，**全局**开关；当前实现不按
  主机单独配置）：关闭后会在下一次同步移除该主机的侧边栏工作区注册，重新开启后在下一次同步重建。
- 侧边栏不新增列：镜像会话就是本地 Session，天然进列表；每台主机一个 `Remote: <主机名>` 工作区负责分组。这正是
  「不新开一列」的实现方式。
- 删除主机时同时删除该工作区注册（目录与会话日志保留），避免留下指向已删主机的空分组；删除失败由启动时的孤儿
  清理补删。

## 10. 分阶段交付与验收

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| P0 ✅ | 目录镜像（L1）+ 本地模拟远端主机 | 用 `e2e/sim` 的模拟主机跑通：侧边栏出现远端会话、状态正确；不连真实主机也能验 |
| P1 🟡 | 历史回放（L2）：**数据层已交付，可见标识待客户端** | 远端会话日志经 SSH 读入 → 本地镜像会话里可读；`cursor` 持久化、重复同步不重复消息、缺口按 §6 重置重拉；`readOnly` 与 `mirror/read-only` 已在 **Host/契约层** 提供（`test/unit/history.test.js` + `test/integration/history.e2e.js` 覆盖）。**未完成**：客户端尚未渲染只读标识（DSH 的 Conversation UI 不显示非 surface 事件），因此「只读标识清晰」这一用户可见目标仍未达成，见 §11 #8 |
| P2 | 事件流 + 输入转发（L3） | **前置条件已完成**（见 §6.2）：租约 epoch/围栏、并发写入检测、`applyEvents` 冲突上报、可注入时钟，均有单测与模拟远端集成测试。**但「围栏」只对共享同一描述符存储的写入者成立**——两个独立客户端都从 epoch 0 起步、都会拿到 epoch 1，彼此不会被定序（§11 #10），所以**不要据此认为 L3 的单写者前提已经满足**。L3 本身仍**未开始**：本地发消息 → 远端执行 → 事件流回本地还没有实现 |
| P3 | 审批桥 + 归档语义 | 远端正问 → 本地弹审批；本地归档不触碰远端 |

L2 的范围是「**回放，不流式**」：它读的是远端已经落盘的会话日志，因此没有实时性承诺；`stream` / `input` /
`approve` 三个能力仍为 `false`，`decideLevel` 也仍停在 L2（`stream-unavailable`）。

## 11. 开放问题（需要在实现前定）

1. 本地镜像会话的**标题与搜索**由谁索引：本地会话库索引副本，还是查询时向远端要？（影响离线体验）
2. 远端「会话列表」的分页与上限：远端可能有数千会话，镜像全量还是按工作区懒加载？
3. `ws-mux` 的事件 schema 稳定性：需要一层 capability 探测与版本门禁，避免远端升级后静默错位。
4. 多客户端同镜像同一远端会话时，写入租约的实现放在本地还是远端？（倾向本地租约 + 远端检测）
5. ~~`mirrorMaxEvents` 的保留策略~~ **已定稿（L2）**：保留最新 N 条（默认 200，0 = 不限），折叠只发生在首次同步，
   并在会话里写一条 `mirror/history-folded` 通知；后续溢出按缺口处理而不是再折叠。不再声称「保留首尾、压缩中段」——
   那会让「游标说完整」与「正文有洞」同时成立。
6. **远端会话日志的真实布局仍只在小范围样本上验证过**：L2 的发现策略是
   `find <DSH_HOME>/sessions -maxdepth 4 -name '*<id>*'`，覆盖 `sessions/<ws>/session-<id>.json[l]` 这类形状；若实测
   出现别的位置或压缩格式，会以 `no-session-log` / `log-malformed` 显式降级（不是静默错位）。拿到真实远端样本后
   应补一个夹具，并把发现策略收敛到确定的一种。
7. 远端日志的**增量读取**：L2 每次都读全量日志再用 `cursor` 过滤。日志很大时这是带宽浪费（虽有 `maxBytes` 上限），
   后续应按字节偏移或尾部读取来优化，并把 `cursor` 与远端日志的物理位置关联起来。
8. **P1 的「只读标识清晰」只完成了数据层**：Host 侧已提供 `MirrorView.readOnly` 与一条 `mirror/read-only` 非
   surface 事件（契约层可断言），但 DSH 的 Conversation UI 不渲染非 surface 事件，客户端也还没有据此绘制任何
   可见标记——所以**用户实际看到的仍是「没有标识的远端历史」**。这是有意的待办而非已完成项：需要客户端在会话头
   或消息列表加一个只读徽标（并用 `redacted`/`level` 说明原因）后才能把 P1 的验收行标为全部达成。
9. **围栏权威（`remote-go/lease.json`）是一个过渡实现，而且只读**：真正的单写者仲裁在 L3 应该走控制通道
   （与事件流同一条 `ws-mux`），并用远端自己的会话锁而不是一个旁挂文件。现在这个文件只是为了在**不改远端**的
   前提下把 epoch / fencing 这套机械先落地并可测；它没有防篡改能力，也不参与远端的真实性校验。更关键的是插件
   **只读不写**：从不发布自己的 `{ writer, epoch, expiresAt }`，所以远端根本没有可用来拒绝过期 epoch 的依据。
10. **两个互不相识的客户端不会被定序（这是当前保证的真实边界）**：各自独立的 `mirrors.json` 都从 `epoch 0` 起步，
    都会拿到 `epoch 1`，也都能通过自己的 `assertWritable`——谁都看不到对方的号码。所以 §6.2 的围栏只覆盖
    **共享同一描述符存储**的写入者（同一 profile 的重启、并发同步）以及远端 `lease.json` 明确声明的第三方。
    要越过这条线，L3 必须补齐：① 双向权威通道（本地要发布，而不是只读）；② 远端按自己的高水位拒绝过期 epoch；
    ③ 真实性绑定（否则第三方发布一个巨大 epoch 就能把所有者围栏掉——当前的棘轮等于一个廉价 DoS）；
    ④ 逐次写检查（现在只是「每批之前」）；⑤ 两主机 + 真分区的时序测试。
11. **围栏场景目前只在模拟远端上验证过**：`fenced` / 恢复路径的测试用 `--lease-fixture` 让模拟远端声明一个更高的
    epoch。真实的「A 分区后归来、B 已接管」需要两个客户端连同一远端会话，并让其中一个真的断网再回来——本仓库
    的测试环境里没有第二台主机，因此没有验证真实并发下的时序竞争。
