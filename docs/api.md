# dsh-remote-go · 本地 Host ↔ Client HTTP API 契约（v1，冻结）

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
  "aliases": [{ "alias": "tencent-vm", "host": "240d:c000:...", "user": "ubuntu", "port": 22, "source": "config" }],
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
    "name": "腾讯云测试机",
    "address": "tencent-vm",
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

