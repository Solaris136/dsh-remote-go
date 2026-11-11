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

> 关键约束：`sidebar.workspaces` 是单占槽位（由 `dsh-client-ui-workspace` 独占），第三方插件无法追加分组
> （[docs/design.md](design.md) §v0.7 附录第 3 条的限制说明，行 ~536）。**所以「完全会话」不能靠改宿主侧边栏
> 实现，只能靠让远端会话本身成为本地会话。**

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
| L2 只读镜像 | L1 + 每会话标题/时间/状态 + 历史正文回放 | 远端 DSH 的 RPC/HTTP（经隧道） | 本地 Conversation UI 里能读远端历史，只读 |
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

## 5. 数据通路

```text
本地 DSH（Host 插件）
├─ 镜像会话存储（本地 Session 记录 + cursor + capabilities）
├─ SSH（ssh2）：认证 / exec / forwardOut          ← 已有
├─ 隧道：127.0.0.1:<localPort> ──▶ 远端 127.0.0.1:<remotePort>   ← 已有
└─ 远端会话适配器（新增）
   ├─ 目录：读远端 storages/workspace.json
   ├─ 历史：远端 RPC 拉取事件区间 [0, lastSeq]
   ├─ 流式：ws-mux 订阅（增量事件 → 追加到本地镜像会话）
   └─ 写入：本地输入 → 远端 RPC（单写者仲裁）

远端服务器：原版 DSH（不装任何专属组件）
```

设计取舍：**不引入远端 agent**。远端就是原版 DSH，镜像所需的目录、历史、事件、输入全部走它已有的 HTTP/RPC
接口；这是本项目相对 `Golden-Pigeon/dsh-remote`（需装 `dsh-remote-agent`）的主要差异，也是「零远端专属组件」
承诺的延续。

## 6. 事件流与游标

- 每个镜像会话持有单调递增 `cursor`（远端事件序号）。本地只追加 `seq > cursor` 的事件，天然幂等。
- 重连：从 `cursor` 续传；远端若已丢弃该区间事件，则降级为「重新拉全量快照 + 重置 cursor」并提示用户。
- 单写者仲裁：本地持有「写入租约」（心跳续约）。租约过期或远端检测到第二个写入者时，本地转为只读并提示，
  绝不并发写。
- 上限：镜像事件数受 `mirrorMaxEvents` 限制（默认取远端窗口大小），超限时保留首尾、压缩中段并标注「已折叠」。

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
- **设置 → 远程主机** 不变，新增「镜像到本地侧边栏」开关（默认开），可按主机关闭。
- 侧边栏不新增列：镜像会话就是本地 Session，天然进列表；这正是「不新开一列」的实现方式。

## 10. 分阶段交付与验收

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| P0 | 目录镜像（L1）+ 本地模拟远端主机 | 用 `e2e/sim` 的模拟主机跑通：侧边栏出现远端会话、状态正确；不连真实主机也能验 |
| P1 | 历史回放（L2） | 本地 Conversation UI 渲染远端历史，只读标识清晰；断线后仍可读 |
| P2 | 事件流 + 输入转发（L3） | 本地发消息 → 远端执行 → 事件流回本地；`seq` 幂等与续传有用例覆盖 |
| P3 | 审批桥 + 归档语义 | 远端正问 → 本地弹审批；本地归档不触碰远端 |

## 11. 开放问题（需要在实现前定）

1. 本地镜像会话的**标题与搜索**由谁索引：本地会话库索引副本，还是查询时向远端要？（影响离线体验）
2. 远端「会话列表」的分页与上限：远端可能有数千会话，镜像全量还是按工作区懒加载？
3. `ws-mux` 的事件 schema 稳定性：需要一层 capability 探测与版本门禁，避免远端升级后静默错位。
4. 多客户端同镜像同一远端会话时，写入租约的实现放在本地还是远端？（倾向本地租约 + 远端检测）
5. `mirrorMaxEvents` 的保留策略（保留首尾、折叠中段、如何标注「已折叠」、按工作区还是按会话计数）：P0 不缓存
   事件，尚未实现，需在 L3 事件存储落地前定稿；在此之前文档与 UI 都不得声称已有事件上限。
