# 完全会话设计（remote sessions as first-class local sessions）

> **English abstract.** Today the remote DSH takes the main content column over as a desktop browser guest (no frame):
> sessions never appear in the local sidebar and never use the local Conversation UI. This document designs the next
> step — *complete sessions*: remote sessions become first-class local sessions (listed natively, opened in the normal
> Conversation UI, streamed, and able to carry approvals back), while the plugin keeps its thin-client, zero-remote-
> component posture. It defines the capability levels, the data model, the event channel, the failure modes and a
> phased delivery plan. The rest is written in Chinese.

## 1. 为什么需要这一层

现状（[docs/design.md](design.md) §4.3）：远端 DSH 以桌面端 guest 接管整窗，等价于「把另一台机器的界面显示出来」。
它的问题不是能不能用，而是**不是本地一等公民**：

- 远端会话不出现在本地侧边栏，切会话必须先切主机再在远端界面里找；
- 远端会话不能进本地 Conversation UI，本地的工作区栏、搜索、快捷键都用不上；
- 两套界面并存（本地一套、远端 guest 一套），用户要在两套心智模型之间切换。

同类项目的经验（2026-11 调研）：`Golden-Pigeon/dsh-remote` 用
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
2. 点开即用**本地原生 Conversation UI** 渲染（不是远端 guest）。
3. 支持流式增量、历史回翻、可归档/改名，状态（等待审批/运行中/空闲）与本地会话一致呈现。
4. 保持既有的安全姿态：凭据不出本地、隧道只回环、版本一致、零远端专属组件。

非目标（明确不做）：

- 不在本地重跑一个 Agent（本地不持有模型凭据、不代跑工具）。
- 不做双向并发写：同一会话同时只允许一个写入者（本地或远端），冲突显式拒绝而不是合并。
- 不接管远端 DSH 的插件/设置/文件/终端管理；这些仍在远端界面（guest 接管的整窗）里完成。

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

> 路径约定（托管 Node 的 npx 运行时）：远端 DSH 的数据在 `~/.dsh`（profile、`storages/workspace.json`、`sessions/**`、凭据），
> 插件固定在自己的状态目录 `~/.dsh/remote-go`（`logs/`、`run/`、`node/`、`downloads/`、租约与流助手）。

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

- 远端（或 L3 落地后的控制通道）发布插件状态目录下的 `$DSH_HOME/remote-go/lease.json`（默认
  `~/.dsh/remote-go/lease.json`；插件子目录，不写 DSH 的 profile/会话文件）：`{ writer, epoch, expiresAt }`。
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
2. 呈现**更高** `epoch` 的写入者在 `epochJumpLimit` 窗口**以内**被接受，并抬高本地高水位（号码即事实）；
   超出窗口的跳变被拒绝且**不采纳**（见下）；呈现更低者一律拒绝。
3. 一次围栏事件只在**同一个 epoch 的第一次**被判定为 `changed`，因此每个会话每次围栏只写一条
   `mirror/fenced` 非 surface 通知，不会每次同步刷屏。
4. 被围栏时：不写、不推进 `cursor`、丢弃自己的租约、descriptor 标 `readOnly: true` + `reason.code = "fenced"`，
   已有历史**原样保留**（只读可看）。
5. 恢复：竞争消失后重新 `acquire` 会拿到 `epoch + 1`，从原 `cursor` 继续——历史不会重拉、不会丢。
6. `#ensureMirrorSessions`（创建本地镜像会话）**有意不经过围栏**：它只创建本地 DSH 会话、不写远端、也不追加
   镜像历史，被围栏的客户端仍然可以「看到」会话列表。围栏管的是**写入远端历史投影**这件事，不是本地可见性。

时钟是**注入**的（`RemoteGoService` 的 `clock`），所以过期与围栏由测试推进假时钟验证，不靠真实等待。
**时钟假设**：`expiresAt` 写在远端墙上时钟里，而 TTL 由本地（注入）时钟度量，两者之间目前没有容差；远端时钟比本地
快超过一个 TTL 时，一条仍有效的记录会被当成已过期而允许一次伪接管。同源时钟的偏差远小于 30 s，所以现阶段只把
这个假设作为已知限制记在本节，跨时区/跨虚拟化部署时应加显式 skew allowance。

**围栏的适用边界（先说清楚，别把 L3 建在错的假设上）**

权威通道现在是**双向**的：本地不只读 `lease.json`，还会在每次拿到租约（acquire 或 renew）后**发布**自己的
`{ writer, epoch, expiresAt, sessionKey }`；远端（L3 之前是同一个文件 + 校验脚本，测试里是模拟远端）**校验并拒绝**
不合格的发布。因此今天被真正定序的是：**共享同一个远端权威的所有写入者**——包括各自拥有独立 `mirrors.json` 的
两个客户端。第二个客户端即使本地从 `epoch 0` 起步，也会在**发布**时被远端拒绝（`stale-epoch`）。

远端侧拒绝规则（`acceptAuthority`）：

| 情况 | 远端决定 |
|---|---|
| 记录缺 `writer` / `epoch` / `sessionKey` | `malformed` 拒绝 |
| `epoch` 比当前高**超过**窗口（默认 1000） | `implausible-epoch` 拒绝且**不采纳**，并记一次可疑跳变 |
| `epoch` 低于当前 | `stale-epoch` 拒绝（这就是过期写入者） |
| 同一 `epoch` 但 `sessionKey` 不同 | `writer-changed` 拒绝 |
| 当前记录已过期（`expiresAt <= now`） | 接受（任何人可接管，崩溃者不会永久占位） |
| 其余（新授权 / 续约 / 墓碑） | 接受 |

**仍未解决（L3 之前必须补）**：

1. **真实性只到「同一个文件」这一层**：`sessionKey` 是**每条连接**随机生成的令牌，它保证「不是这条连接就不能续约
   这份租约」，但**不构成秘密**——能同时读写该文件的一方可以照抄 key。真正的绑定需要远端侧持有密钥（HMAC 挑战，
   或与 SSH 会话绑定的令牌），现在没有。
2. **`lease.json` 仍是过渡实现**：真实 L3 应走控制通道并使用远端自己的会话锁，而不是一个旁挂文件。
3. **远端侧的拒绝目前由模拟远端实现**：未改造的真实 DSH 没有这个校验脚本，所以对真实远端而言「远端拒绝」
   仍是设计而非现实（§11 #11）。
4. **逐次写检查**：现在仍是「每批之前」检查两次（读前 + append 前）；真正并发下应由远端原子校验每次写。
5. **两主机 + 真分区测试**：两个「客户端」目前是两个 service 实例连同一个模拟远端，不是两台真实主机。

**可疑跳变不是 DoS 面**：棘轮（号码大者胜）本身会让「发布一个巨大 epoch」变成一行拒绝服务。所以远端和本地
**两侧都**加了窗口（`LEASE_LIMITS.epochJumpLimit` / 构造参数 `epochJumpLimit`，默认 1000）：超出窗口的跳变被
拒绝、记为 suspicious，且**不抬高**本地高水位，攻击者无法靠一次发布把我们永久围栏。

### 6.3 镜像描述符的单写者（已落地）

`#syncMirrors` 的 reconcile 与 `#syncMirrorHistory` 都会持久化描述符。先前的代码各自读一份快照、再整体写回，
所以两个并发写入者会互相覆盖——后写的一方用过期快照丢掉先写方刚推进的 `cursor`（lost update）。

**这条竞态是可复现的，不只是理论**：`syncHostMirrors` 只用 `runtime.mirrorSync` 与**连接流程**做合并
（先看有没有在飞的同步、有就等它），但它在等待之后是**直接调用同步**、并不会把自己注册进 `runtime.mirrorSync`。
因此两个并发调用都会看到 `null` 并同时执行。触发方式很日常：面板轮询 + 手动同步、两个标签页、或者重连与面板刷新
撞在一起。校准结果：没有队列时 `mirror_a cursor 0 | mirror_b cursor 7`（丢掉 A 的 5），有队列时 `5 | 7`。

修法：`src/mirror-writer.js`

- `withMirrorWriter(runtime, read, write, delta)`（`src/mirror-writer.js:28`）——**读当前值 → 应用增量 → 持久化**，
  每个 host 一条 Promise 队列串行执行；读与写之间没有可被插入的 `await`。delta 抛错不会把队列卡死
  （`withMirrorQueue` 在 `src/mirror-writer.js:54` 用 `then(run, run)` 接上失败）。
- `mergeDescriptorDeltas`（`src/mirror-writer.js:80`）——单调字段（`cursor` / `epoch` / `conflictCount`）只增不减
  （`src/mirror-writer.js:93`）；delta 未提及的描述符原样保留，不会被顺手删掉。
- 两个既有持久化点都改走这里（`#mutateMirrors`，`src/service.js:2051`），是**单一入口**而不是在某一处加锁。

#### 删除也必须走同一条队列（否则会「复活」）

只有写入串行还不够：**删除**同样会改这批描述符。如果它绕过队列，一个在飞的同步就会把用户刚删掉的主机的镜像
写回来。三个促成因素（修复前都在 `main` 上）：

1. `removeHost` **直接**调用 `mirrorStore.removeHostMirrors`，绕过了队列；
2. `#teardownRuntime` 不等待 `runtime.mirrorSync`，所以在删之前启动的同步会继续跑完；
3. `mergeDescriptorDeltas` 会把「delta 里有、current 里没有」的描述符**插回去**。

顺序：同步读到快照 → 用户删主机 → 描述符被清空 → 同步排队中的写入落地 → 描述符复活。

**规则（本版定稿）**：

- **删除与同步写入共用一条每 host 队列。** `withMirrorQueue(runtime, run)`（`src/mirror-writer.js:54`）让任意镜像
  操作排进同一条链；`removeHost` 的删除通过它执行（`#removeMirrorsForHost`，`src/service.js:2069`），
  因此不可能插进某次同步的「读 → 增量 → 持久化」中间。
- **墓碑优先于排序。** `removeHost`（`src/service.js:404`）在**第一个 `await` 之前**就置
  `runtime.mirrorDeleted = true`（`src/service.js:411`）；这个判断放在 `withMirrorWriter` 的**排队操作内部**
  （`src/mirror-writer.js:35`），所以哪怕某次写入是在删除**之前**入队、在删除**之后**才执行，它也只返回 `current`、
  不写回，不会复活。队列只能重排顺序，墓碑才能保证结果——这就是两者都要的原因。
  把判断放在 `withMirrorWriter` 而不是某个调用方，是为了让**所有**写入路径自动继承它，也让它可以被测试直接驱动
  （不必在测试里复制一份守卫逻辑）。
- **合并是更新，不是 upsert。** `mergeDescriptorDeltas` 只改 `current` 里已存在的描述符（`src/mirror-writer.js:80`）；
  delta 指向一个已经不存在的 `localSessionId` 时**丢弃**它（`src/mirror-writer.js:88`）——那正意味着「快照读完之后
  它被删了」。新建描述符是 reconcile 的职责（它返回计划的全集），不是 merge 的。
- **reconcile 只看当前存储。** 旧的 `current.length > 0 ? current : existing` 回退会在 `current` 为空时用删除前
  的快照重建描述符，是复活 bug 的第二个入口，已移除。
- **可观测**：删除时写一行日志（`mirror host removed: descriptor writes are now no-ops`，`src/service.js:412`），
  不再静默。

### 6.4 L3 第一阶段：轮询跟随（已落地，默认关闭）

**这不是推送通道，先说清它是什么**：传输是请求/响应式 `ssh.exec`，`tail -f` 会阻塞到超时并返回空，所以实现是
**轮询跟随**——每个 host 一个定时器，重复调用远端小助手取「偏移之后的日志切片」。诚实的性质：**延迟 ≈ 轮询间隔**
（`STREAM_LIMITS.pollMs`，`src/mirror-stream.js:30`）、按日志顺序、**至少一次**投递（由 `seq > cursor` 与
`data.mirrorSeq` 幂等化）、单帧有界、内存有界。真正的推送通道（`ws-mux`）仍未实现，这是已知缺口。

**内存为什么有界**：没有队列。每一帧在下一 tick 被排程**之前**就应用完（`setTimeout` 在 `await` 之后，
`src/service.js:2132`），所以慢的下游自然产生背压，而不是积压；占用上界就是**单帧**的大小
（`maxBytes` 256 KB / `maxEvents` 500，`src/mirror-stream.js:32`）。早期版本有一个 `FrameBuffer`，但轮询循环
从不入队，它只是装饰，已删除——不要在没有队列的情况下声称「丢帧计数」。。

**状态存放**：`cursor` 是**唯一持久真相**，只在描述符里，且所有描述符写入都经 `withMirrorWriter`
（`src/mirror-writer.js:28`）；流式路径不直接调 `replaceHostMirrors`。`offset` 与日志路径是**每连接的内存状态**
（`runtime.streamOffsets` / `runtime.streamFiles`，`src/service.js:253` 创建），**不持久化**——两个必须一致的持久
数字就是漂移 bug；重启时 offset 归零、路径在连接同步时重新发现，`seq > cursor` 让重读成为 no-op。

**非对称规则**：offset 只在描述符写入成功**且持久化的 cursor 真的前进**之后才推进（`advanced` 判断，
`src/service.js:2224`）。offset 落后只会重读已应用字节（廉价且正确）；offset 超前而 cursor 没动会**跳过从未应用的
事件 = 永久丢数据**，所以永不提前推进。

**生效路径**：`#startMirrorStream` 在 `#syncMirrors` 里紧随 `#syncMirrorHistory` 调用——**让激活真正生效的那一行是
`src/service.js:668` 的 `this.#startMirrorStream(runtime)`**。远端助手在**第一次轮询时**惰性安装
（`#ensureStreamHelper`，`src/service.js:2084`）：早期尝试在 connect 时安装，那时 `runtime.facts?.home` 还不存在，
路径留空且静默放弃——这就是「已实现但看不到」的根因。守卫以 `streamGuard`（`src/mirror-stream.js`）返回
`guard` 名称而不是裸 `return`。

**可观测性（本节的教训）**：第一次尝试的插桩发在 `debug`，默认 `logLevel` 为 `info` 会把它过滤掉，于是「看不到」被
误读成「没发生」。现在轮询在**没有前进**时以 `info` 打印六值轨迹
（`{sessionId, offsetBefore, rawBytes, parsedEvents, planCursor, persistedCursor, guard}`，`src/service.js:2224` 附近），
可见性由**被测试覆盖**的 `logVisible`（`src/mirror-stream.js:287`）决定，`options.logLevel` 可覆盖（`src/service.js:180`）；
`runtime.logs` 环形缓冲始终保留全部行。**一条一般规则**：插桩必须在**默认配置**下就能看见，且要用一个断言证明它
真的会打印——否则它只会安慰写它的人。

**远端那一半是模拟的——必须知道这一点**：上面列的都是**插件侧**性质。远端助手
（`remoteStreamScriptSource()`，`src/mirror-stream.js`）在 CI 里**从未真正执行**：单元测试只把它当**字符串**读
（`test/unit/mirror-stream.test.js`），集成测试里**模拟远端拦截了命令并直接返回预制 JSON**
（`e2e/sim/simulated-remote.mjs:580` 丢弃安装命令、`:584` 用正则匹配 follow 命令）。也就是说，助手的偏移算术、
epoch 检查、切片与 JSON 组帧从未跑过；被验证的是**模拟端对协议的重新实现**。要让它真正跑起来需要一台装了 `node`
且在 `PATH` 上、并有可写插件状态目录（`~/.dsh/remote-go`）的远端 DSH。因此 §10 的 P2 只应读作「插件侧端到端已验证，远端为模拟」。
**开关**：`mirrorStream` 默认 **false**（`src/settings.js:51`）。关闭时行为与引入跟随者之前逐字节相同；开启后每个 host
多一次轮询，把远端新记录追加到本地镜像。**激活已端到端验证**：`test/integration/stream.e2e.js` 四个测试——连接期间
追加的记录无需手动同步即出现且只出现一次、**关闭开关的负对照**、被围栏的 host 不流任何东西、重连从持久 cursor 续接且
不重复。
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
- **设置 → 远程主机** 不变。设置新增「镜像会话」分组里的 `mirrorToSidebar`（默认关，**全局**开关；当前实现不按
  主机单独配置）：关闭后会在下一次同步移除该主机的侧边栏工作区注册，重新开启后在下一次同步重建。
- 侧边栏不新增列：镜像会话就是本地 Session，天然进列表；每台主机一个 `Remote: <主机名>` 工作区负责分组。这正是
  「不新开一列」的实现方式。
- 删除主机时同时删除该工作区注册（目录与会话日志保留），避免留下指向已删主机的空分组；删除失败由启动时的孤儿
  清理补删。

## 10. 分阶段交付与验收

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| P0 ✅ | 目录镜像（L1）+ 本地模拟远端主机 | 用 `e2e/sim` 的模拟主机跑通：侧边栏出现远端会话、状态正确；不连真实主机也能验 |
| P1 ✅（仅数据层；无可见标识） | 历史回放（L2）+ 只读标识 | 远端会话日志经 SSH 读入 → 本地镜像会话里可读；`cursor` 持久化、重复同步不重复消息、缺口按 §6 重置重拉；`readOnly` 与 `mirror/read-only` 在 Host/契约层提供（`test/unit/history.test.js` + `test/integration/history.e2e.js`）。**可见标识没有交付**：曾经渲染徽标的面板工作区栏已整体移除，DSH 也未向插件暴露「会话头/标题」slot（插件只能注册 `main`、`settings.section` 与 `sidebar.panellist`），因此侧边栏工作区行与 Conversation UI 内部都没有只读标记，见 §11 #8 |
| P2 🟢 | 事件流（L3 第一阶段） | **已落地，默认关闭**（`mirrorStream`）。轮询跟随：远端助手在远端侧拒绝过期 epoch，本地按偏移取帧、复用 L2 的 `planHistoryWindow` 落库，`cursor` 是唯一持久真相、`offset` 只存内存且仅在持久化 cursor 前进后才推进。端到端验证见 §6.4 与 `test/integration/stream.e2e.js`。**仍未做**：真正的推送通道（`ws-mux`）、L3 输入转发、审批桥 |
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
8. ~~**P1 的「只读标识清晰」只完成了数据层**~~ **仍停在数据层**：曾经在插件面板工作区栏渲染的
   `mirror-readonly-badge` 已随该栏一起移除，现在没有可见的只读徽标；`readOnly` 与 `mirror/read-only`
   仍在 Host/契约层提供（数据来自 `GET /hosts/:id/mirrors`，没有第二套数据源）。要恢复可见标识，
   需要宿主先提供可注入的 slot（会话头/标题或工作区行）。
   **粒度注意**：只读判定数据本身是主机级的（`mirror.readOnly` 由该主机的回放状态决定），不是逐会话；
   将来 **L3 允许部分会话可输入后必须改为按会话**——否则整个主机都会被标成只读。
   （根因备注：在徽标可被渲染之前，还发现并修复了一个真实缺陷——`sessions.create` 对 `isSeeded` 会话强制要求
   显式 `seed` 与 `inheritedEventCount`，而适配器只在 `seed` 非空时才传，导致**每个镜像会话创建都失败**、L2
   在真实壳里从未回放过。见 §4.1。）
9. ~~**围栏权威是只读的**~~ **已关闭（本版）**：插件现在会**发布**自己的
   `{ writer, epoch, expiresAt, sessionKey }`（acquire/renew 后发布，断开时写墓碑），远端**校验并拒绝**过期 epoch、
   key 不符与可疑跳变。**仍然开放的部分**：插件状态目录里的 `remote-go/lease*.json` 本身还是过渡形态（真实 L3 应走 `ws-mux` 控制
   通道 + 远端会话锁）；**真实性只到「同一文件」这一层**——`sessionKey` 是每条连接随机生成的令牌，能同时读写该
   文件的一方可以照抄，真正的绑定需要远端侧持密钥（HMAC / 与 SSH 会话绑定的令牌）。
10. ~~**两个互不相识的客户端不会被定序**~~ **已关闭，但不是全部（本版）**：两个独立 `mirrors.json` 的客户端现在
    会被远端定序——第二个即使在本地从 `epoch 0` 起步，其**发布**也会被远端拒绝（`stale-epoch` / `writer-changed`），
    已用两个 service 实例连同一个模拟远端验证（只有一个能写，另一个 `reason.code="fenced"` 且不追加任何事件）。
    **仍然开放**：① 逐次写检查（现在仍是「每批之前」两次，而不是每次 append 前，或由远端原子校验）；
    ② 真实远端没有这个校验脚本（见 #11）；③ 真实性绑定如上。
11. **「远端拒绝」目前只在模拟远端上成立**：`acceptAuthority` 是 `e2e/sim` 里的校验逻辑，用来代表未改造 DSH 之外的
    权威。真实场景需要远端侧真的执行这套拒绝（L3 控制通道或一个远端组件），并且要**两台真实主机**才能验证
    「A 分区归来、B 已接管」的时序竞争——本仓库的测试环境没有第二台主机，因此「两个客户端」是两个 service 实例
    连同一个模拟远端。
12. **模拟远端的校验顺序有一个已知偏差**：`acceptAuthority` 把「当前记录已过期」的分支放在跳变检查**之前**，
    所以走那条路径的接管可以采纳一个任意大的 epoch（不构成永久 DoS——下一个写入者仍可 +1 拿回，但它确实绕过了
    `epochJumpLimit` 窗口）。真实实现应把窗口检查放在最前面；这里保持现状是因为它只影响测试替身，且已有测试
    覆盖窗口本身。
13. **事件流：第三次尝试成功，激活已端到端验证（默认关闭）**：前两次的结论（「与同步路径无法共存」）是**错的归因**，
    真正的原因有两个，都在之后修掉了：① `#syncMirrors` 与 `#syncMirrorHistory` 各自读快照再整体写回造成的 lost update
    （PR #23 的 `withMirrorWriter`）；② `streamFile` 在历史结果存在前被引用的 TDZ 异常被吞成 `read-failed`，静默关掉
    历史回放（PR #25 的 swallow 守卫）。**本次实测的第三个障碍是插桩本身**：轨迹发在 `debug`，默认 `logLevel` 过滤掉，
    于是「看不到」被误读成「没发生」——教训是插桩必须在默认配置下可见，并用断言证明它真的会打印（现由
    `logVisible` + 单元测试保证）。**还有一个纯属我自己的 bug**：诊断输出写在会先失败的断言之后，所以它从未执行。
    **诚实边界**：远端助手（`remoteStreamScriptSource()`）在 CI 中**从未执行**——模拟远端拦截命令并返回预制 JSON
    （`e2e/sim/simulated-remote.mjs:580`/`:584`），单元测试只把它当字符串读。被验证的是插件侧加上模拟端对协议的
    重新实现，真实远端行为需要一台有 `node` 与可写插件状态目录（`~/.dsh/remote-go`）的机器才能验证。
    **现状**：`mirrorStream` 默认 false；开启后连接期间追加的远端记录无需手动同步即出现且只出现一次（负对照：关闭时
    不出现）；被围栏的 host 不流任何东西；重连从持久 cursor 续接且不重复。**下一个尝试者需要**：一条真正的推送通道
    （`ws-mux`）来消掉「延迟 ≈ 轮询间隔」，以及 L3 的输入转发与审批桥。
