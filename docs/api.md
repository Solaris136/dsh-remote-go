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
  windowMode: 'panel' | 'external'
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

> 说明：DSH 的侧边栏工作区列表是 `sidebar.workspaces` 单位单占槽位，第三方插件无法向其中追加分组（该槽位由 `dsh-client-ui-workspace` 独占）。因此本插件把「本地工作区 + 按远端分组的工作区」放在远程面板自己的左侧工作区栏里，并在设置页提供「远程主机」管理；本地侧边栏的工作区列表保持原样、互不影响。

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

某台远端主机已镜像到本地的会话（P0 = L1 目录镜像）。只读，不触发任何远端调用；目录同步发生在主机连接成功时，
也可由 Host 内部显式触发。未连接时返回上次快照并带 `connected:false`，不报错。

```json
{
  "ok": true,
  "hostId": "h_x",
  "hostName": "腾讯云测试机",
  "connected": true,
  "level": "L1",
  "reason": {
    "code": "history-unavailable",
    "detail": { "zh": "远端没有可用的历史回放接口，只做目录镜像（L1）。", "en": "The remote exposes no history replay…" }
  },
  "capabilities": { "list": true, "history": false, "stream": false, "input": false, "approve": false },
  "sessionsAvailable": true,
  "resyncRequired": 1,
  "notice": { "zh": "本地镜像会话在重启后不保留…", "en": "Mirror sessions do not survive a restart yet…" },
  "mirrors": [
    {
      "localSessionId": "mirror_1a2b3c4d5e6f7g8h9i0j1k2l3",
      "hostId": "h_x",
      "remoteSessionId": "session-42",
      "workspaceId": "ws_1",
      "title": "proj · session-",
      "cursor": 0,
      "capabilities": { "list": true, "history": false, "stream": false, "input": false, "approve": false },
      "level": "L1",
      "reason": {
        "code": "version-mismatch",
        "message": { "zh": "远端 DSH（0.2.1）与本机（0.2.2-rc.1）版本不一致，只做目录镜像（L1）。", "en": "…" }
      },
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
  /** 已镜像到的远端事件序号（1 起；0 = 尚未同步），重连后从这里续传 */
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

**会话创建上限（`mirrorMaxSessions`）**：设置项 `mirrorMaxSessions`（默认 `200`，`0` = 不限制）限制每次同步最多为多少条
镜像描述创建本地会话。`sessionLimit` 是本次生效的上限（`0` 表示不限制），`truncated` 是被上限挡下、本次未尝试创建的
描述数，`skipped` 是其中**确实缺少本地会话**的数量。上限只限制「创建」：不会删除任何早先创建的会话，因此调低上限
不会让已有会话变成孤儿（它们既不计入 `skipped`，也不会被移除）；上限生效时仍会注册侧边栏分组（只要至少有会话创建
成功），不会留下空分组。未连接 / 注册表不可读 / 瞬时空注册表时，`truncated` 与 `skipped` 均为 `0`。

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
   **P0 未接线**：`src/mirror.js` 里的游标合并（`applyEvents`）与租约判定（`acquireLease` 等）是带 `@internal`
   标记的纯函数，没有调用方；事件流、输入转发、审批回传在 L3 才落地，v1.1 不声称已交付 §6。
8. 事件上限 `mirrorMaxEvents`（保留首尾、折叠中段、标注「已折叠」）**尚未实现**，P0 也不缓存事件；
   它随 L3 事件存储一起落地（见 session-design.md §11）。
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
    （0700 目录、0600 文件、随机临时名 + `wx`、文件与目录 fsync、`EPERM`/`EBUSY` 重命名重试、跨进程锁、
    失败清理临时文件）。区别仍在各自的读取语义：`hosts/settings/secrets` 读取损坏时回退默认值（不回退后写坏文件），
    镜像存储会把损坏/更高版本的文件另存而不是覆盖。所有文件均不含凭据或 token。简短的“写入实现统一”说明：两个存储
    都把「写」交给同一模块，每个存储仍保留自己的错误与回退策略。
