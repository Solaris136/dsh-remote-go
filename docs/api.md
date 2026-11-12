# dsh-remote-go · 本地 Host ↔ Client HTTP API 契约（v1 冻结 + v1.1 增补）

> 本文件是 Host 插件（`src/`）与 Client 插件（`client.js`）之间的唯一协议。两侧都不得依赖对方的内部实现。
> 基地址：`/dsh-remote-go/api`（挂在本地 DSH Web 服务同源路由下）。
> 编码：请求/响应均为 `application/json; charset=utf-8`（SSE 除外）。
> 约定：所有请求带 `x-dsh-remote-go: 1` 请求头；所有响应为 `{ ok: true, ... }` 或 `{ ok: false, error: ErrorView }`。

## 0. 通用类型

```ts
/** 双语文本；服务端只回结构化文本，客户端原样展示。 */
type I18nText = { zh: string; en: string }

/** 错误视图（分类见设计文档 §8.4）。 */
interface ErrorView {
  code: string            // 见下表
  title: I18nText
  detail: I18nText
  nextSteps: I18nText[]
  /** 是否可重试（决定 UI 是否显示「重试」按钮） */
  retryable: boolean
  /** 可选技术细节（已脱敏，不建议直接展示给用户，放「诊断」里） */
  technical?: string
}

type HostStatus =
  | 'unconfigured'        // 灰点：未连接过
  | 'connecting'          // 蓝点：连接中（配合 phase/progress）
  | 'fingerprint-pending' // 黄点：等待用户确认主机指纹
  | 'connected'           // 绿点：远端界面可用
  | 'disconnected'        // 黄点：断线，可重连
  | 'error'               // 红点：连接/认证/服务失败
  | 'limited'             // 紫点：能连但远端无法提供界面

type ConnectPhase = 'ssh' | 'probe' | 'bootstrap' | 'start' | 'tunnel' | 'ready'

/** 进度：客户端用 code 查本地文案，params 用于插值（如主机名、版本号、百分比）。 */
interface Progress {
  code: string
  params?: Record<string, string | number>
}

interface FingerprintView {
  sha256: string          // "SHA256:xxxx"（标准 OpenSSH 形式）
  keyType: string         // "ssh-ed25519"
  /** observed = 本次会话看到但未记录；pinned = 已记录且匹配；changed = 与记录不一致 */
  status: 'pending' | 'pinned' | 'changed' | 'observed'
  /** 已记录的指纹（pinned 时展示） */
  pinned?: string | null
}

interface RemoteView {
  version: string | null        // 远端 DSH 版本
  uiReady: boolean              // 远端 Web 界面是否可达
  localPort: number | null      // 本地回环隧道端口
  pid: number | null            // 远端 web 进程 pid
  dshHome: string | null        // 远端 DSH_HOME
  bootstrapLevel: string | null // T0 / T0-local / T1 / T2 / T3（实际使用）
  nodeVersion: string | null
  startedAt: string | null      // ISO
}

interface HostView {
  id: string
  name: string
  /** SSH 地址或 ~/.ssh/config 别名（原样展示） */
  address: string
  /** 脱敏展示：user@host:port（密码永远不会出现） */
  addressMasked: string
  /** 认证方式类型；password 时客户端应在连接前弹一次性密码框（密码不落盘） */
  authType: 'agent' | 'key' | 'password'
  /** 可选跳板机（原样展示，未配置为 null） */
  jumpHost: string | null
  status: HostStatus
  phase: ConnectPhase | null
  progress: Progress | null
  error: ErrorView | null
  /** 非致命提示（如版本不一致已沿用、iframe 被禁止嵌入）：连接仍可用 */
  warning: I18nText | null
  fingerprint: FingerprintView | null
  remote: RemoteView
  keepAlive: 'keep' | 'stop' | 'idle'
  idleMinutes: number
  autoReconnect: boolean
  hostKeyPolicy: 'first-use' | 'strict'
  /** 该主机的远端目标版本与版本一致性（连接后有意义） */
  targetVersion: string | null
  versionParity: {
    status: 'same' | 'different' | 'unknown'
    local: string | null
    remote: string | null
    same: boolean
    message: I18nText
  }
  lastOpenedAt: string | null
  createdAt: string
  updatedAt: string
}

interface SettingsView {
  defaultPort: number
  defaultAuth: 'agent' | 'key' | 'password'
  connectTimeoutSec: number
  autoReconnect: { enabled: boolean; maxAttempts: number; baseDelayMs: number }
  hostKeyPolicy: 'first-use' | 'strict'
  saveTokens: boolean            // 默认 false（token 仅内存）
  /** v1.1：把远端镜像会话注册到本地侧边栏（默认 true） */
  mirrorToSidebar: boolean
  /** v1.1：每次同步最多新建多少个镜像会话（默认 200，0 = 不限；只限制创建） */
  mirrorMaxSessions: number
  /** v1.1（L2）：是否回放远端历史（默认 true；false 时所有镜像停在 L1） */
  mirrorHistory: boolean
  /** v1.1（L2）：单个镜像会话保留/回放的事件上限（默认 200，0 = 不限；超出保留最新 N 条） */
  mirrorMaxEvents: number
  /** 呈现形态：'panel' = 面板内嵌（iframe）；'overlay' = 接管整个窗口（DSH 桌面端用 Chromium guest 铺满窗口，顶部窄条可刷新/退出） */
  windowMode: 'panel' | 'overlay'
  language: 'auto' | 'zh' | 'en'
  logLevel: 'error' | 'warn' | 'info' | 'debug'
  /** 自举：目标版本取 'local' = 跟随本机 DSH 版本 */
  bootstrap: {
    targetVersion: string        // 'local' 或精确版本
    mode: 'auto' | 'reuse' | 'npx' | 'isolated'
    remoteDir: string            // 远端隔离目录（默认 ~/.dsh-remote-go）
    nodeVersion: string          // 下载 Node 的精确版本（T3 用）
  }
}

interface StateView {
  hostVersion: string | null     // 本机 DSH 版本
  targetVersion: string | null   // 远端目标版本（解析后）
  hosts: HostView[]
  settings: SettingsView
  activeHostId: string | null
  /** 客户端 UI 提示用：是否首次使用（决定是否显示「远端任务会继续运行」提示） */
  firstRun: boolean
}
```

### ErrorView.code 取值

| code | 分类 | 可重试 |
|---|---|---|
| `network` | 网络不可达 | ✅ |
| `auth` | SSH 认证失败 | ✅ |
| `host-key-changed` | 主机指纹变化 | ❌（需用户确认/重置） |
| `host-key-unknown` | 首次连接，等待确认 | ✅（确认后） |
| `remote-dsh-missing` | 远端无 DSH 且无法自举 | ✅ |
| `remote-dsh-start-failed` | 远端 DSH 启动失败 | ✅ |
| `remote-ui-unreachable` | 远端界面打不开 | ✅ |
| `version-mismatch` | 远端版本与本机不一致 | ✅（选择升级/沿用后） |
| `unsupported-os` | 远端系统不支持（如 Windows） | ❌ |
| `offline` | 无网络，离线包不可用 | ✅ |
| `invalid-input` | 表单/参数不合法 | ❌ |
| `internal` | 插件内部错误 | ✅ |

## 1. 端点

### `GET /state`
返回当前完整状态。客户端轮询兜底；实时更新用 SSE。

```json
{ "ok": true, "state": StateView }
```

### `GET /events`（SSE）
`text/event-stream`。连接后立即推送一次 `state`，随后状态变化时推送；每 15s 一次 `ping`。
**鉴权例外**：EventSource 无法设置自定义请求头，因此该路由只校验 Origin 同源 / 非 cross-site（不发送任何 CORS 头，浏览器会阻止跨站 EventSource），不要求 `x-dsh-remote-go` 头。

```text
event: state
data: { "hostVersion": "0.2.2-rc.1", "hosts": [...], ... }

event: ping
data: {}
```

### `GET /health`
无副作用探活（不需要状态）：`{ "ok": true, "version": "0.1.0" }`。

### `GET /ssh/aliases`
扫描本机 `~/.ssh/config` 与 `~/.ssh/known_hosts`（只读）。

```json
{
  "ok": true,
  "aliases": [{ "alias": "my-server", "host": "192.0.2.10", "user": "ubuntu", "port": 22, "source": "config" }],
  "knownHosts": { "entries": 12, "hashed": 0, "hosts": ["github.com"] }
}
```

### `POST /hosts`
新增或更新主机（带 `id` 为更新）。密码字段仅用于「本次连接」，永不落盘。

请求：
```json
{
  "host": {
    "id": "h_xxx",
    "name": "构建服务器",
    "address": "my-server",
    "port": 22,
    "username": "ubuntu",
    "auth": { "type": "agent" } | { "type": "key", "keyPath": "~/.ssh/id_rsa" } | { "type": "password" },
    "jumpHost": null,
    "keepAlive": "keep",
    "idleMinutes": 15,
    "autoReconnect": true,
    "hostKeyPolicy": "first-use"
  }
}
```
响应：`{ "ok": true, "host": HostView }`。校验失败 `invalid-input`。

### `DELETE /hosts/:id`
删除主机（同时断开、按策略决定是否停止远端）。响应 `{ "ok": true }`。

### `POST /hosts/:id/connect`
发起连接（异步）。立即返回 `{ "ok": true }`，进度通过 `/events` 的 `state` 推送。
请求（均可选）：
```json
{
  "password": "仅本次连接使用，不保存",
  "rememberFingerprint": true,
  "acceptHostKey": "SHA256:xxx",
  "overrideVersion": false        // true = 允许远端版本不一致时继续
}
```

### `POST /hosts/:id/disconnect`
请求 `{ "stopRemote": false }`。`stopRemote=true` 时同时停止远端 web。

### `POST /hosts/:id/reconnect`
等价于 disconnect(不停止远端) + connect。

### `POST /hosts/:id/fingerprint`
响应用户的指纹确认。请求 `{ "accept": true, "remember": true, "sha256": "SHA256:xxx" }`。

### `GET /hosts/:id/open`
仅在 `status === 'connected'` 时可用。返回带一次性 token 的本地回环 URL（同源 iframe 用，绝不出现在日志）：
```json
{ "ok": true, "url": "http://127.0.0.1:54321/?token=...", "localPort": 54321 }
```
每个主机每次连接只返回同一 URL；`?token=` 只用一次完成 cookie 种入，之后 iframe 由远端自己重定向到干净地址。

### `POST /hosts/:id/activate`
设置面板当前展示的主机（客户端打开面板前调用；失败可忽略）。无请求体，返回 `{ "ok": true }`。

### `GET /local/workspaces`
本地 DSH 的工作区清单（供面板左侧「本地工作区」分组使用；只读，来自本机 DSH 的持久化工作区注册表）。

```json
{
  "ok": true,
  "source": "file",
  "initialized": true,
  "defaultWorkspaceId": "1a46…",
  "workspaces": [
    { "id": "132b…", "title": "dsh-remote-go", "path": "C:\\Work\\dsh-remote-go", "sessionCount": 1, "createdAt": "…", "updatedAt": "…", "isDefault": false, "origin": "local" }
  ]
}
```

### `GET /hosts/:id/workspaces`
某台远端 DSH 的工作区清单（面板左侧「<主机名>」分组）。未连接时返回 `connected:false` 而不是报错：

```json
{
  "ok": true,
  "hostId": "h_x",
  "hostName": "腾讯云测试机",
  "connected": true,
  "dshHome": "/home/ubuntu/.dsh-remote-go/home",
  "initialized": true,
  "defaultWorkspaceId": "…",
  "workspaces": [
    { "id": "…", "title": "proj", "path": "/home/ubuntu/proj", "sessionCount": 3, "createdAt": "…", "updatedAt": "…", "isDefault": false, "origin": "remote", "hostId": "h_x", "hostName": "腾讯云测试机" }
  ]
}
```

> 说明：DSH 的侧边栏工作区列表是 `sidebar.workspaces` 单位单占槽位，第三方插件无法向**该槽位**追加分组（由 `dsh-client-ui-workspace` 独占）。因此本插件把「本地工作区 + 按远端分组的工作区」放在远程面板自己的左侧工作区栏里，并在设置页提供「远程主机」管理。
>
> v1.1 补充：宿主另有一个可选的 `workspaceRegistry` 服务（`create`/`resolveByPath`/`list`/`delete`），插件**可以**通过它在本地侧边栏注册工作区。自该能力接入后，连接主机会额外注册一个 `Remote: <主机名>` 工作区承载镜像会话；面板内的工作区栏与它**并存**，不是替代关系。见 `docs/session-design.md` §4.3。

### `POST /hosts/:id/diagnose`
执行完整检查表（可能需要数秒）。

```json
{
  "ok": true,
  "report": {
    "summary": "ok" | "warning" | "error",
    "checks": [
      { "id": "ssh-reachable", "title": {"zh":"SSH 可达性","en":"SSH reachability"}, "status": "pass"|"fail"|"unknown", "detail": {"zh":"...","en":"..."} }
    ],
    "redacted": true,
    "generatedAt": "2026-11-10T15:00:00.000Z"
  }
}
```

检查项 id（顺序固定）：`ssh-reachable`、`auth`、`host-key`、`tunnel`、`remote-service`、`remote-ui`、`remote-version`、`model-credentials`、`desktop-guard`。

### `POST /settings`
局部更新设置：`{ "patch": { ...部分 SettingsView } }` → `{ "ok": true, "settings": SettingsView }`。

### `POST /local-version`
客户端把页面里读到的本机 DSH 版本回填给 Host（Host 探测失败时的兜底）：
`{ "version": "0.2.2-rc.1" }` → `{ "ok": true }`。

## 2. 进度 code 表（客户端本地化）

| code | 说明 |
|---|---|
| `ssh-connecting` | 正在连接 SSH |
| `host-key-checking` | 正在校验主机指纹 |
| `host-key-confirm` | 等待用户确认主机指纹 |
| `auth-checking` | 正在认证 |
| `probing` | 正在探测远端环境 |
| `bootstrapping` | 正在准备远端运行时 |
| `bootstrap-progress` | 自举进度（params.template / params.detail） |
| `starting-remote` | 正在启动远端 DSH |
| `starting-remote-wait` | 等待远端 DSH 就绪（params.seconds） |
| `tunneling` | 正在建立本地回环隧道 |
| `verifying` | 正在验证远端界面 |
| `ready` | 就绪 |
| `reconnecting` | 断线重连中（params.attempt / params.max） |

## 3. 安全约束（客户端必须遵守）

1. 密码只在 `connect` 请求体里出现一次，不写入任何客户端存储；不放到 URL。
2. `token`/带 token 的 URL 只在内存中传递：`GET /open` 拿到的 URL 直接赋给 `iframe.src`，不写 localStorage、不打印日志。
3. `saveTokens` 默认 false；为 true 时由 Host 在 `$DSH_HOME` 下以 0600 保存，客户端不接触。
4. 所有 `fetch` 用 `credentials: 'same-origin'`，并带 `x-dsh-remote-go: 1`。
5. iframe 只允许 `http://127.0.0.1:<port>`（Host 保证）；客户端必须校验 `url.startsWith('http://127.0.0.1:')` 再赋值。
6. 非回环地址在 UI 上给出明确警告（设计 §9.2）。

## 4. v1.1 新增（向后兼容；v1 语义未改动）

> 本节是 v1 的**追加**契约：不修改、不重定义上面任何端点或字段。客户端可以忽略它；Host 在宿主未提供
> `sessions` 服务时仍按 v1 工作（镜像端点只返回已持久化的目录描述）。设计依据见
> [session-design.md](session-design.md) §3（数据模型）、§4.1/§4.2（契约变更）、§6（事件流与游标）、§7（失败模式）。

### `GET /hosts/:id/mirrors`

某台远端主机已镜像到本地的会话（**L2 = 目录镜像 + 历史回放**）。只读，不触发任何远端调用；目录同步与历史回放
发生在主机连接成功时，也可由 Host 内部显式触发。未连接时返回上次快照并带 `connected:false`，不报错。

```json
{
  "ok": true,
  "hostId": "h_x",
  "hostName": "腾讯云测试机",
  "connected": true,
  "level": "L2",
  "reason": null,
  "capabilities": { "list": true, "history": true, "stream": false, "input": false, "approve": false },
  "sessionsAvailable": true,
  "resyncRequired": 0,
  "notice": null,
  "mirrors": [
    {
      "localSessionId": "mirror_1a2b3c4d5e6f7g8h9i0j1k2l3",
      "hostId": "h_x",
      "remoteSessionId": "session-42",
      "workspaceId": "ws_1",
      "title": "proj · session-",
      "cursor": 5,
      "capabilities": { "list": true, "history": true, "stream": false, "input": false, "approve": false },
      "level": "L2",
      "reason": null,
      "mirroredAt": "2026-11-11T00:00:00.000Z",
      "status": "active"
    }
  ]
}
```

`resyncRequired` / `notice` 来自连接时后台同步产生的「重启后从远端重拉」提示（见下节）：它**不是**瞬时值，
在客户端确认之前一直返回；没有待确认提示时为 `0` / `null`。

每条 `MirrorView` 都带自己的 `level` / `reason`（与顶层同源，来自 `decideLevel`），因此「这台主机版本不匹配，
所以这几个会话只做目录镜像」可以直接显示在会话行上，而不必只挂在主机卡片上（设计 §7）。这两个字段在每次成功
同步时写入并持久化；`GET` 返回的是**最近一次成功同步**的判定，主机版本变化后会在下一次同步时刷新。

```ts
type MirrorLevel = 'L1' | 'L2' | 'L3'

interface MirrorCapabilities {
  list: boolean // 远端工作区/会话目录可读（L1 必需）
  history: boolean // 远端历史回放可用（L2）
  stream: boolean // 远端事件流可订阅（L3）
  input: boolean // 远端接受输入转发（L3）
  approve: boolean // 远端审批可回传本地（L3）
}

interface MirrorView {
  /** 稳定派生：`mirror_` + 25 位 base36（sha256(hostId + NUL + remoteSessionId) 截断 128 位） */
  localSessionId: string
  hostId: string
  remoteSessionId: string
  workspaceId: string | null
  /** L1 为占位标题（工作区标题 · 远端会话 id 前缀）；L2 换成远端会话标题 */
  title: string
  /** 已镜像到的远端事件序号（1 起；0 = 尚未同步）。L2 下等于「已投影到本地会话的最大 `seq`」，
   *  持久化在 mirrors.json 里，重启后从它续传；缺口时停在缺口前的最后一个连续事件 */
  cursor: number
  capabilities: MirrorCapabilities
  /** 该镜像会话最近一次同步时判定的能力级别（设计 §7：版本不匹配要标注在会话上，而不只是主机上） */
  level: MirrorLevel
  /** 该级别被降级的原因；`null` 表示已到该级最高能力。`message` 为双语文本 */
  reason: { code: string; message: { zh: string; en: string } } | null
  /** 最后一次成功同步时间（ISO）；失败/部分同步路径保留旧值，从未同步为 null */
  mirroredAt: string | null
  /** 远端会话被删除时只标记，不删除本地记录（设计 §7） */
  status: 'active' | 'remote-deleted'
  /** L2：已回放历史的镜像会话为只读投影（L3 才有输入通道）。客户端据此标注「只读」 */
  readOnly: boolean
  /** L3 前置（§6.2）：本机是否**当前持有可能写入的租约**。与 `readOnly` 是两件事：会话仍是只读投影，
   *  但本机持有租约意味着它是被授权的写入者，下次同步会继续追加历史 */
  writable: boolean
  /** 围栏令牌（单调递增）。重启后从 descriptor 恢复，不会回退 */
  epoch: number
  /** 当前租约；`null` = 没有（被围栏、已过期或从未获取） */
  lease: { owner: string, acquiredAt: number, renewedAt: number, expiresAt: number, epoch: number } | null
  /** 上一次已经通报过的围栏事件（去重用，客户端一般不渲染） */
  fencedEpoch: number | null
  fencedWriter: string | null
  /** 同 `seq` 但内容不同被丢弃的记录（保留首个），最多 20 条 */
  conflicts: Array<{ seq: number, kept: string, lost: string }>
  /** 累计冲突数（不受 20 条上限约束） */
  conflictCount: number
}
```

### `POST /hosts/:id/mirrors/sync`

立即重读远端工作区注册表并同步镜像目录，然后返回每个镜像会话在**本地**的落地结果。这是「重启后从远端重拉」提示的
入口（`GET /mirrors` 只读，不创建会话）。未连接时返回 `synced:false, reason:"not-connected"`，不报错。

```json
{
  "ok": true,
  "hostId": "h_x",
  "synced": true,
  "level": "L1",
  "reason": { "code": "history-unavailable", "detail": { "zh": "…", "en": "…" } },
  "sessionsAvailable": true,
  "markedDeleted": [],
  "revived": [],
  "resyncRequired": 1,
  "notice": { "zh": "本地镜像会话在重启后不保留…", "en": "Mirror sessions do not survive a restart yet…" },
  "sessionLimit": 200,
  "truncated": 0,
  "skipped": 0,
  "history": {
    "enabled": true,
    "attempted": 2,
    "applied": 10,
    "appended": 10,
    "folded": 0,
    "skipped": 0,
    "failures": []
  },
  "sidebar": {
    "ok": true,
    "enabled": true,
    "reason": null,
    "hostId": "h_x",
    "path": "C:\\Users\\me\\.dsh\\remote-go\\mirrors\\h_x",
    "title": "Remote: 腾讯云",
    "workspaceId": "1a2b…",
    "created": true,
    "renamed": false
  },
  "sessions": [
    {
      "ok": true,
      "created": true,
      "localSessionId": "mirror_1a2b3c4d5e6f7g8h9i0j1k2l3",
      "cursor": 0,
      "resync": { "needed": true, "from": 0, "reason": "local-session-missing", "notice": { "zh": "…", "en": "…" } },
      "notice": { "zh": "…", "en": "…" }
    }
  ],
  "mirrors": [MirrorView]
}
```

`synced:false` 的两种情况都**不改动**已持久化的镜像状态：`reason:"unreadable"`（注册表读不到/不可解析）与
`reason:"empty-registry"`（注册表可解析但 0 个工作区，通常是一次写入中途的瞬时状态）。`sessions[]` 是适配器的
原始结果（`ok:false` 时带 `reason`，如 `sessions-unavailable` / `create-failed`）。

### L2 历史回放（v1.1）

L2 在 L1 之上把远端会话的**历史**投影成本地镜像会话的内容。远端仍是原版 DSH，插件只用 SSH `exec` 读远端
`<DSH_HOME>/sessions` 下的会话日志，**不需要任何远端专属组件**。

- **能力与级别**：`capabilities.history=true` 且顶层 `level` 为 `L2`，仅当本次同步确实读到了历史（或此前已有
  `cursor > 0`）。`mirrorHistory:false`、或日志读不到/格式不认识/版本更新时，该镜像会话保持 `L1` 并带 `reason`。
- **`history` 汇总**（仅 `POST /hosts/:id/mirrors/sync` 返回）：`attempted` 本次尝试的会话数，`applied` 本次判定为
  可应用的远端事件数，`appended` 实际写入本地会话的事件数（两者不等说明被 `mirrorSeq` 去重挡下了重复），
  `folded` 因超出保留上限而被显式折叠的**前缀**事件数，`failures[]` 为 `{ localSessionId, reason }`，
  `fenced` 本次因围栏而停写的会话数，`conflicts` 本次上报的冲突数，`conflictSeqs` 对应的 `seq` 列表，
  `internalErrors` 本次因**插件自身缺陷**而失败的次数（对应 `reason.code="internal-error"`，与远端失败分开计数）。
- **幂等**：写入本地会话的事件都带 `data.mirrorSeq`（远端 `seq`）。同步只应用 `seq > cursor`，并在 append 前用
  会话里已有的 `mirrorSeq` 再挡一次（真机读 `snapshotEvents()`，不是不存在的 `events` 属性），因此重复同步、以及
  「append 成功后 cursor 尚未落盘就崩溃」都不会重复消息。
- **缺口**：远端日志缺号时，先按 §6 的「重置游标 + 全量重拉」恢复一次（日志里能看到
  `cursor … is unreachable … re-pulling the full log`）。重拉后仍不连续，才写入 `reason.code="gap-unfilled"`，
  游标停在缺口前的最后一个连续事件——不会跳过缺口，也不会永远重试同一段不可达区间。
- **只读标识**：回放过历史的镜像会话在 `MirrorView` 上带 `readOnly: true`，并在会话里写一条一次性的
  `mirror/read-only` 非 surface 事件（带 `capabilities: { input:false, stream:false, approve:false }`），
  客户端据此标注「只读」；重复同步不会重复写入该通知。客户端的可见标识在**插件面板的工作区栏**：远端工作区行
  渲染 `只读镜像` / `Read-only mirror` 徽标（`data-testid="mirror-readonly-badge"`），tooltip 为
  `<级别> 只读镜像：<原因>`（无 `reason` 时用「远端历史以只读方式回放…」的默认文案），只在 `readOnly === true`
  时出现。徽标以**工作区行**为粒度（`mirror.workspaceId === workspace.id`）：同一工作区里只要有只读镜像就标注，
  所以它是这一组镜像的类目标签，而不是逐会话标签。镜像列表读取失败时**不显示**徽标（首次读取与重新读取都一样，
  失败会清空缓存列表，避免残留旧徽标）。DSH 尚未向插件暴露会话头 slot，因此 Conversation UI 内部没有该徽标
  （见 session-design.md §10 P1 / §11 #8）。
- **保留上限**：`mirrorMaxEvents`（默认 200，`0` = 不限；默认值在 `src/settings.js:46`，生效值在
  `src/service.js:740`）限制单次回放的事件窗口。超限时保留**最新**的 N 条并在会话里先写一条
  `mirror/history-folded`（非 surface 事件，带真实的 `folded` / `from` / `to` / `retained`，
  以及 `retentionCap` / `fetchCap` 两个上限；见 `src/service.js:998`），然后从新的窗口起点继续；折叠只发生在
  首次同步（`src/service.js:1036` 传入 `foldBeforeCursor: cursor === 0`，判定在 `src/history.js:745`），
  之后的溢出按缺口处理（`src/service.js:1064` 用 `cursor: 0` + `foldBeforeCursor: true` 全量重拉一次），
  避免「游标说完整、正文却有洞」。

`reason.code` 在 L2 新增的取值：

| code | 含义 |
|---|---|
| `sessions-dir-missing` | 远端没有 `sessions/` 目录（DSH 还没写过会话日志） |
| `no-session-log` | 目录存在，但找不到该会话的日志文件 |
| `read-failed` | 读取失败（连接/超时/命令失败），下次同步重试 |
| `permission-denied` | 日志不可读（权限不足）。读取命令保留 `2>&1`，所以该错误真的能被分类出来，而不是退化成 `no-session-log` |
| `log-truncated` | 日志超过读取上限，本次跳过以免回放半截内容 |
| `log-malformed` | 日志无法解析 |
| `unknown-version` | 日志版本高于本插件，跳过以免错位映射 |
| `gap-unfilled` | 远端历史有缺口，游标停在缺口前 |
| `history-disabled` | 设置里关闭了历史回放，保持 L1 |
| `fenced` | 写入租约被更新的 epoch 接管（§6.2）：本地停止写入、保持只读、`cursor` 不推进；历史仍可查看 |
| `internal-error` | **插件自身缺陷**导致本次读取失败（例如代码里的 `TypeError`/`ReferenceError`、非预期的返回结构）。**这不是远端条件**：同一次同步会在 `logs` 里留下一条 `error` 级别的 `mirror history INTERNAL ERROR …`（含异常名、消息与堆栈），并把 `history.internalErrors` 加一。客户端应把它当作缺陷上报，而不是「远端拒绝」 |

**内部缺陷 vs 远端条件（v1.1 增补）**：`internal-error` 是唯一一个**不代表远端状态**的取值，它的存在是为了
让缺陷无法伪装成远端条件。判定规则是结构性的，不是靠匹配错误文案：`try` 的边界就是 I/O 调用本身
（`src/history.js:637` 的 `execRemote()` 只包住 `await ssh.exec(...)`），因此只有传输层的 reject 才会映射成
`read-failed` / `permission-denied`（`src/history.js:554`）；`fetchRemoteHistory()`（`src/history.js:617`）外层
`catch` 只可能捕获到插件自己代码抛出的异常，统一由 `internalHistoryFault()`（`src/history.js:568`）报告为
`internal-error` + `internal: true` + `internalError: { name, message, stack }`。
`stack` **只进 error 日志**（`src/service.js:707`），**不写入描述符**：失败落盘时描述符只保留
`{ level: 'L1', reason }`（`src/service.js:968-972`），所以镜像记录里不会出现堆栈。同步汇总里的
`internalErrors`（`src/service.js:965` 计数）与 `failures[].reason="internal-error"` 是对外可观测的信号，
`CONTRIBUTING` §9 把这套写法定为约定；防回归的扫描器是 `test/unit/swallow-guard.test.js`（默认违规：
任何产出 `reason:` 的 `catch` 都必须可区分或带 `// swallow-ok: <≥2 词>`）。

远端记录到本地事件的映射（保留/丢弃的字段）见 [session-design.md](session-design.md) §6.1。

**会话创建上限（`mirrorMaxSessions`）**：设置项 `mirrorMaxSessions`（默认 `200`，`0` = 不限制）限制每次同步最多为多少条
镜像描述创建本地会话。`sessionLimit` 是本次生效的上限（`0` 表示不限制），`truncated` 是被上限挡下、本次未尝试创建的
描述数，`skipped` 是其中**确实缺少本地会话**的数量。上限只限制「创建」：不会删除任何早先创建的会话，因此调低上限
不会让已有会话变成孤儿（它们既不计入 `skipped`，也不会被移除）；上限生效时仍会注册侧边栏分组（只要至少有会话创建
成功），不会留下空分组。未连接 / 注册表不可读 / 瞬时空注册表时，`truncated` 与 `skipped` 均为 `0`。

**围栏与写入租约（v1.1，L3 前置）**：每次同步会先向远端读一次可选的写入权威
`<DSH_HOME>/remote-go/lease.json`（`{ writer, epoch }`），再决定本机能否写：

- 远端 `epoch` **高于**本地高水位 → 本机已被接管：`MirrorView.readOnly=true`、`level="L1"`、
  `reason.code="fenced"`、`cursor` **不推进**、租约被清空，并写一条 `mirror/fenced` 非 surface 通知
  （`{ readOnly, epoch, remoteEpoch, remoteWriter, reason }`）。历史保持只读可看。
- 同一个 `epoch` 但写入者不同 → 同样视为围栏（`writer-changed`）；**同一次围栏只通报一次**，
  重复同步不会刷屏（去重键是 `fencedEpoch` + `fencedWriter`）。
- 权威文件不存在 / 为空 → 视为「没有竞争写入者」，本机照常持有租约（这是未改造远端的正常状态）。
- 权威文件存在但损坏 → `lease-malformed`，**不会**被当成「没人写」，本机不推进也不写入。
- 恢复：竞争消失后本机 `acquire` 会拿到 `epoch+1`，从原 `cursor` 继续；`epoch` 高水位持久化在
  `mirrors.json` 里，重启不会回退（重启后的自己是「续约」而不是「新写入者」）。

**权威通道是双向的（v1.1，L3 前置）**：本机不只读 `lease.json`，还会在每次拿到租约（acquire 或 renew）后**发布**
`{ version: 1, writer, epoch, expiresAt, sessionKey }`，断开时写入墓碑（`expiresAt = now`，让别的客户端立刻可接管）。
远端**校验并拒绝**不合格的发布，拒绝以一行机器可读文本返回，本机把它映射为类型化原因：

| 远端答复 | 本机映射 | 含义 |
|---|---|---|
| `dsh-lease: stale-epoch <n>` | `fenced` | 远端持有更新的 epoch：本机被定序掉，停止写入、`cursor` 不推进 |
| `dsh-lease: writer-changed <n>` | `fenced` | 同 epoch 但 `sessionKey` 不属于本机 |
| `dsh-lease: implausible-epoch <n>` | `fenced` + `suspicious` | 跳变超出窗口（默认 1000），拒绝且不抬高本机高水位 |
| `dsh-lease: malformed` | `fenced` | 记录缺字段 |
| 退出码非 0（非上述） | `fenced` | `publish-failed` / `permission-denied` 等 |

发布被拒绝时**不会**退化成「照旧写入」——否则通道就只是装饰。同步响应里对应 `history.fenced` 与
`history.suspicious`。

**仍然开放（不要在 L3 里当成已解决）**：`sessionKey` 是**每条连接**随机生成的令牌，保证「不是这条连接就不能续约
这份租约」，但**不是秘密**——能同时读写该文件的一方可以照抄；真实的绑定需要远端侧持密钥。远端的校验逻辑目前由
模拟远端实现（未改造的真实 DSH 没有）。逐次写检查仍是「每批之前」而非每次 append。两主机真分区时序测试缺失。
详见 session-design.md §6.2 与 §11 #9-#11。

**并发写入（v1.1 内部修复）**：描述符的持久化现在统一走单写者（读 → 应用增量 → 持久化，每个 host 串行），
修复了 reconcile 与 history 两路写入互相覆盖 `cursor` 的缺陷。对客户端而言字段语义不变，只是 `cursor` 不再
可能倒退或被并发写覆盖。
**冲突上报**：同一 `seq` 出现内容不同的记录时，仍按「保留首个」处理（默认策略不变），但会记录到
`MirrorView.conflicts`（最多 20 条，`kept`/`lost` 各带一段 ≤120 字符摘要 + 7 位短哈希，使截断后仍可区分）。
`conflictCount` 只统计**本次真正应用**的记录上的冲突，并按 `(seq, kept, lost)` 去重，所以 L2 每次重读整份日志
（见 session-design.md §11 #7）**不会**让计数虚增；同步响应里对应 `history.conflicts` / `history.conflictSeqs`。

**提示的生命周期**：连接成功后 Host 会在后台跑同一条同步，并创建本地镜像会话（此时 `created:true` /
`resync.needed:true`）。客户端随后调用本端点时，会话已经存在（`created:false` / `resync:null`），所以
`resyncRequired` / `notice` 返回的是**后台同步留下、尚未确认**的那条提示，而不是本次调用的结果；`GET
/hosts/:id/mirrors` 也返回同一对字段。客户端展示后应带 `{ "acknowledgeResync": true }` 再调用一次本端点来清除。

**侧边栏工作区（`sidebar`）**：DSH 侧边栏按工作区列会话，工作区成员由会话头的规范化 cwd 推导，所以 Host 会把每台
主机的镜像目录 `$DSH_HOME/remote-go/mirrors/<hostId>` 注册成一个工作区（标题 `Remote: <主机名>`，与会话 `meta.cwd`
用同一个路径函数产出；镜像根在插件加载时先做一次 `fs.realpath`，两个适配器共用同一个规范化路径，见设计 §4.3）。
`sidebar` 是该注册的落地结果：

| 字段 | 含义 |
|---|---|
| `ok` / `reason` | `ok:false` 时 `reason` ∈ `adapter-absent` / `adapter-error` / `workspaces-unavailable` / `create-failed` / `no-mirror-root` / `invalid-host`；`ok:true` 且 `reason` 非空表示**有意跳过或移除**：`disabled`（`mirrorToSidebar=false`，若此前注册过则**已移除**）、`sessions-unavailable`（没有可分组的本地会话，含「本次同步所有 `sessions.create` 都失败」）、`no-mirrors`（远端没有镜像会话） |
| `enabled` | 设置 `mirrorToSidebar` 是否为开 |
| `path` / `title` / `workspaceId` | 注册的工作区；跳过或失败时可为 `null`。`path` 是**注册表规范化后**的路径（`fs.realpath`），不是调用方传入的字面路径 |
| `created` / `renamed` | 本次是否新建 / 是否因主机改名而改了标题；复用既有注册时两者皆 false |
| `removed` | 仅 `reason="disabled"` 时有意义：是否真的移除了既有注册（没有注册时为 false，幂等） |

注册是幂等且非致命的：`workspaceRegistry`（可选依赖）缺失或报错只影响侧边栏分组，连接与镜像本身照常完成。
关闭 `mirrorToSidebar` 会在下一次同步（连接或 `POST …/mirrors/sync`）时**移除**已有注册——否则该分组会永远留在侧边栏
（镜像会话只在内存中，重启后不会有会话填回）；重新开启后同一同步会重建注册。`DELETE /hosts/:id` 会删除该注册；
若这次删除失败，下次启动的孤儿清理会对镜像根下没有对应主机的注册做一次幂等补删。
`GET /mirrors` 不返回 `sidebar`（只读端点不做实时注册表查询），需要时以本端点的返回为准。

请求（两者均可选，空请求体等价于 `{}`）：

```json
{ "acknowledgeResync": true }
```

### `GET /local/workspaces`、`GET /hosts/:id/workspaces` 的追加字段

v1.1 在这两个端点的 `workspaces[]` 每个工作区对象上**追加** `sessionIds: string[]`（注册表里的会话 id，
保持原文件顺序、**去空白后按 id 去重**）。`sessionCount` 保持 v1 语义（该工作区的会话数）并且恒等于
`new Set(sessionIds).size`，也就是 L1 为每个远端会话建立的镜像条数（`[" s1 ", "s1"]` 只算 1 条）。v1 已有字段
语义不变；不关心镜像的客户端可以忽略 `sessionIds`。

v1.1 约束：

1. `level` 由能力探测决定：版本不一致 → `L1` + `reason.code="version-mismatch"`；版本未知 → `L1` +
   `version-unknown`；无可用探测 → `L1` + `probe-missing`；目录不可读 → `L1` + `list-unavailable`；
   无历史回放 → `L1` + `history-unavailable`；无事件流 → `L2` + `stream-unavailable`；
   无输入/审批 → `L2` + `input-unavailable` / `approve-unavailable`。P0 只实现 `L1`。
2. 能力探测**只认字面 `true`**：`{ "stream": "yes" }`、`{ "input": 1 }` 都不算确认（`stream/input = false`）。
3. `reason` 为 `null` 表示已达到该级最高能力；`code` 沿用 §0 的 `ErrorView.code` 命名，另加 `probe-missing`、
   `list-unavailable`、`history-unavailable`、`stream-unavailable`、`input-unavailable`、`approve-unavailable`、
   `version-unknown`。
4. 本地镜像会话由 Host 通过宿主 `ctx.sessions` 创建（`create(id, { seed, meta })`，`meta` 带 `isSeeded: true`
   标记与 `$DSH_HOME/remote-go/mirrors/<hostId>` 工作目录），该服务是**可选**的：缺失时端点仍返回目录描述，
   只是没有可点开的本地会话，插件其余功能不受影响。
5. 持久化限制：`ctx.sessions` 只做内存存储，镜像会话在插件重启后不保留（P0 不挂载 session-log writer）。
   重启后 Host 重新创建会话并从远端重新拉取（`cursor` 归零）；该提示由 `POST /hosts/:id/mirrors/sync` 的
   `resyncRequired` / `notice` / `sessions[].resync` 返回，客户端应展示「重启后从远端重拉」。
6. 远端会话被删除时，本地记录保留并标记 `status="remote-deleted"`；Host 不会调用远端删除接口。注册表可解析但
   为空时按瞬时状态处理（`reason:"empty-registry"`），不批量标记删除。
7. 写入语义：同一镜像会话同时只允许一个写入者；租约过期或发现第二个写入者时转为只读并提示，绝不并发写。
   **L2 状态**：游标合并（`applyEvents` / `nextCursor`）**已接线**，由 L2 历史回放实际调用（`src/history.js`
   的 `planHistoryWindow` 与 `src/service.js#syncMirrorHistory`），不再带 `@internal` 标记。租约判定
   （`acquireLease` / `renewLease` / `expireLease` / `isLeaseHeldBy`）仍标 `@internal`：事件流、输入转发、审批回传
   在 L3 才落地，因此 v1.1 只声称交付了 §6 的**游标**部分，不声称交付写入租约。
8. 事件上限 `mirrorMaxEvents`（默认 `200`，`0` = 不限制，上限 `5000`）**已在 L2 实现**：保留**最新** N 条，
   超出部分作为前缀折叠，并在会话里写一条 `mirror/history-folded`（带 `folded` / `from` / `to` / `retained`）。
   折叠只发生在首次同步（`cursor == 0`）；之后的溢出按缺口处理并触发 §6 的「重置游标 + 全量重拉」。
   注意它约束的是**回放窗口**，与 `HISTORY_LIMITS.maxEvents`（远端日志单次最多解析 2000 条，防止超大日志拖垮同步）
   是两个不同的上限：前者决定本地保留多少，后者决定一次读取多少。
9. 镜像记录沿用 §3 安全约束：0700 目录、0600 文件、原子写（随机临时名 + `wx` + fsync + 目录 fsync）；
   损坏或更高 `version` 的文件会被**另存**为 `mirrors.json.corrupt-<ts>` / `mirrors.json.future-<ts>` 而不是
   被覆盖；不含任何凭据或 token。
10. 侧边栏可见性：镜像会话只有在「镜像目录被注册为工作区」时才会出现在 DSH 侧边栏（成员关系由会话头的规范化
    cwd 决定，`meta` 没有 workspaceId）。Host 通过可选依赖 `ctx.workspaceRegistry` 注册 `Remote: <主机名>` 工作区，
    路径与会话 `meta.cwd` 完全一致——镜像根在插件加载时先 `fs.realpath` 一次（缺失时创建），两个适配器共用这个
    规范化根，因此符号链接/junction 不会让「字面路径」与「注册表路径」分叉。`create` 前先 `resolveByPath`，所以
    重连不产生重复注册。设置 `mirrorToSidebar=false` 时会**移除**已有注册（幂等；`sidebar.removed` 说明是否真的删了），
    而不是仅停止新建；重新开启后在下一次同步重建。删除主机时删除注册；删除失败由启动时的孤儿清理补删
    （只删镜像根下没有对应主机的注册，从不删除目录）。`workspaceRegistry` 缺失时该能力整体降级为
    `adapter-absent`，不影响 v1 的任何字段。
11. **契约版本探测**：`GET /version` 追加 `apiVersion`（当前 `"1.1"`），与插件 `version` 并列返回。客户端据此
    判断是否可以使用本节的追加契约，不需要靠探测 404 猜能力；`apiVersion` 未来升级只增不改，v1 字段语义不变。
12. **设置追加字段 `mirrorMaxSessions`**：`SettingsView` 追加 `mirrorMaxSessions: number`（默认 `200`，`0` = 不限制，
    上限 `5000`）。它只影响本地镜像会话的**创建**数量，见 `POST /hosts/:id/mirrors/sync` 的 `sessionLimit` /
    `truncated` / `skipped`；v1 的设置字段语义不变，旧客户端可忽略该字段。
13. **写入实现统一**：`hosts.json` / `settings.json` / `secrets.json` 与 `mirrors.json` 现在共用同一个原子写入器
    （0700 目录、0600 文件、随机临时名 + `wx`、文件与目录 fsync、`EPERM`/`EBUSY` 重命名重试、失败清理临时文件），
    并且每个状态文件都在自己的 `<file>.lock` 跨进程锁内写入（同一文件的并发写不会交错；不同文件各持一把锁，
    互不阻塞，`saveSettings` 先写 settings 再写 secrets 不构成嵌套）。区别仍在各自的读取语义：`hosts/settings/secrets`
    读取损坏时回退默认值（不回退后写坏文件），镜像存储会把损坏/更高版本的文件另存而不是覆盖。所有文件均不含
    凭据或 token。
