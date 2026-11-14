# dsh-remote-go · 本地 Host ↔ Client HTTP API 契约（v2.0）

> 本文件是 Host 插件（`src/`）与 Client 插件（`client.js`）之间的唯一协议。两侧都不得依赖对方的内部实现。
>
> - 基地址：`/dsh-remote-go/api`（挂在本地 DSH Web 服务同源路由下）
> - 编码：JSON 为 `application/json; charset=utf-8`（SSE 除外）
> - 响应：成功 `{ "ok": true, ... }`；失败 `{ "ok": false, "error": ErrorView }`
> - 鉴权：除 `/health` 与 `/events` 外，所有请求必须带 `x-dsh-remote-go: 1`
>
> **v2.0 变更**：移除镜像/工作区相关端点（`GET /local/workspaces`、`GET /hosts/:id/workspaces`、
> `GET /hosts/:id/mirrors`、`POST /hosts/:id/mirrors/sync`）。主机、连接、诊断与设置端点保持不变。

## 0. 通用类型

```ts
/** 双语文本；服务端只回结构化文本，客户端按当前语言选择。 */
type I18nText = { zh: string; en: string }

interface ErrorView {
  code: string            // 见下表
  title: I18nText
  detail: I18nText
  nextSteps: I18nText[]
  retryable: boolean      // UI 是否显示「重试」
  technical?: string      // 已脱敏的技术细节，仅放诊断里
}

type HostStatus =
  | 'unconfigured'        // 未连接过
  | 'connecting'          // 连接中（配合 phase/progress）
  | 'fingerprint-pending' // 等待确认主机指纹
  | 'conflict-pending'    // 远端已有手工 DSH，等待用户选择
  | 'connected'           // 远端界面可用
  | 'disconnected'        // 断线，可重连
  | 'error'               // 连接/认证/服务失败
  | 'limited'             // 保留：能连但远端无法提供界面

type ConnectPhase = 'ssh' | 'probe' | 'bootstrap' | 'start' | 'tunnel' | 'verifying' | 'ready'

/** 客户端按 code 查本地文案，params 只用于插值。 */
interface Progress {
  code: string
  params?: Record<string, string | number>
}

interface FingerprintView {
  sha256: string        // 标准 OpenSSH 形式 "SHA256:..."
  keyType: string       // 例如 "ssh-ed25519"
  status: 'pending' | 'pinned' | 'changed' | 'observed'
  pinned?: string | null
}

interface RemoteView {
  version: string | null        // 远端 DSH 版本（= 本机版本）
  uiReady: boolean
  localPort: number | null      // 本地隧道端口
  port: number | null           // 远端 web 端口（回环）
  pid: number | null
  dshHome: string | null        // 远端真实 ~/.dsh
  profile: string | null        // 默认 web
  bootstrapLevel: string | null // 运行时形态；当前恒为 'npx'
  nodeVersion: string | null    // 插件托管 Node 的版本
  nodeSource: 'managed' | null  // 当前恒为 'managed'
  startedAt: string | null      // ISO
}

interface HostView {
  id: string
  name: string
  address: string               // 地址或 ~/.ssh/config 别名
  addressMasked: string         // user@host:port 展示形式
  authType: 'key' | 'password'
  passwordSaved: boolean        // 凭据存储里是否有；永不返回值
  passwordStorageAvailable: boolean
  jumpHost: string | null
  status: HostStatus
  phase: ConnectPhase | null
  progress: Progress | null
  error: ErrorView | null
  warning: I18nText | null      // 非致命提示（如手工实例并存）
  fingerprint: FingerprintView | null
  conflict: {                   // 仅 conflict-pending 时非空
    detectedAt: string
    processes: { pid: number; command: string }[]
  } | null
  remote: RemoteView
  keepAlive: 'keep' | 'stop' | 'idle'
  idleMinutes: number
  autoReconnect: boolean
  hostKeyPolicy: 'first-use' | 'strict'
  targetVersion: string | null  // = 本机 DSH 版本
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
  defaultAuth: 'key' | 'password'
  defaultKeyPath: string        // 默认 ~/.ssh/id_ed25519
  connectTimeoutSec: number
  autoReconnect: { enabled: boolean; maxAttempts: number; baseDelayMs: number }
  hostKeyPolicy: 'first-use' | 'strict'
  saveTokens: boolean           // 默认 false（token 仅内存）
  language: 'auto' | 'zh' | 'en'
  logLevel: 'error' | 'warn' | 'info' | 'debug'
  bootstrap: {
    profile: string             // 远端 profile（默认 web；拒绝 desktop）
  }
}

interface StateView {
  hostVersion: string | null    // 本机 DSH 版本
  targetVersion: string | null  // = 本机 DSH 版本
  hosts: HostView[]
  settings: SettingsView
  activeHostId: string | null
  firstRun: boolean             // hosts.length === 0
}
```

### ErrorView.code

| code | 分类 | 可重试 |
|---|---|---|
| `network` | 网络不可达 | ✅ |
| `auth` | SSH 认证失败 | ✅ |
| `host-key-changed` | 主机指纹变化 | ❌ |
| `host-key-unknown` | 首次连接，等待/超时未确认 | ✅（确认后） |
| `remote-dsh-missing` | 托管 Node 安装失败 / 远端无法运行 npx | ✅ |
| `remote-dsh-start-failed` | 远端 DSH 启动失败 | ✅ |
| `remote-dsh-running` | 手工 DSH 冲突且用户取消/停止失败 | ✅ |
| `remote-ui-unreachable` | 隧道或远端界面校验失败 | ✅ |
| `version-mismatch` | npx 回读版本与本机不一致 | ✅ |
| `unsupported-os` | 远端系统不支持 | ❌ |
| `invalid-input` | 参数不合法 | ❌ |
| `internal` | 插件内部错误 | ✅ |

## 1. 端点

### `GET /health`（免鉴权）

```json
{ "ok": true, "version": "0.1.0", "at": "2026-11-14T00:00:00.000Z" }
```

### `GET /state`

```json
{ "ok": true, "state": StateView }
```

### `GET /events`（SSE，仅 Origin 栅栏）

`text/event-stream`。连接后立即推一帧 `state`，随后状态变化时推送，每 15s 一次 `ping`。
EventSource 无法设置自定义请求头，因此该路由只校验 Origin 同源 / 非 cross-site。

```text
event: state
data: { ...StateView }

event: ping
data: {}
```

### `GET /version`

```json
{ "ok": true, "version": "0.1.0", "apiVersion": "2.0", "hostVersion": "0.2.2-rc.1" }
```

### `GET /diagnostics/self`

返回插件入口与 client-module 图行，用于验收/排障：

```json
{
  "ok": true,
  "plugin": { "id": "dsh-remote-go", "version": "0.1.0" },
  "at": "…",
  "home": "…",
  "stateDir": "…",
  "hostVersion": "0.2.2-rc.1",
  "entry": { "id": "dsh-remote-go", "name": "dsh-remote-go" },
  "client": { "graph": { "rev": "…", "release": { }, "entries": 1 }, "row": { }, "bundle": { } }
}
```

### `GET /ssh/aliases`

只读扫描本机 `~/.ssh/config` 与 `~/.ssh/known_hosts`：

```json
{
  "ok": true,
  "aliases": [{ "alias": "my-server", "host": "192.0.2.10", "user": "ubuntu", "port": 22, "source": "config" }],
  "knownHosts": { "entries": 12, "hashed": 0, "hosts": ["github.com"] }
}
```

### `GET /keyfile/list?path=<dir>`

只读目录浏览，供客户端选择私钥文件。范围限制在用户主目录内，拒绝 `..` 与符号链接逃逸。

```json
{
  "ok": true,
  "path": "C:\\Users\\me\\.ssh",
  "parent": "C:\\Users\\me",
  "entries": [{ "name": "id_ed25519", "path": "C:\\Users\\me\\.ssh\\id_ed25519", "isDirectory": false }],
  "truncated": false,
  "defaultKeyPath": "~/.ssh/id_ed25519",
  "defaultDir": "C:\\Users\\me\\.ssh"
}
```

### `POST /hosts`

新增或更新主机（带 `id` 为更新）。认证只有私钥文件或密码两种；`auth.type="key"` 省略 `keyPath` 时用 `SettingsView.defaultKeyPath` 补齐。密码不经此接口传输。

```json
{
  "host": {
    "id": "h_xxx",
    "name": "构建服务器",
    "address": "my-server",
    "port": 22,
    "username": "ubuntu",
    "auth": { "type": "key", "keyPath": "~/.ssh/id_ed25519" },
    "jumpHost": null,
    "keepAlive": "keep",
    "idleMinutes": 15,
    "autoReconnect": true,
    "hostKeyPolicy": "first-use"
  }
}
```

响应 `{ "ok": true, "host": HostView }`；校验失败返回 `invalid-input`。

### `DELETE /hosts/:id`

断开（按存活策略决定是否停远端）并删除记录，同时取消该主机所有计时器。响应 `{ "ok": true }`。

### `POST /hosts/:id/connect`

发起连接（异步）。立即返回 `{ "ok": true, "accepted": true }`；已在连接/已连接时返回 `{ "ok": true, "accepted": false, "reason": "already-connecting" | "already-connected" }`。进度通过 `/events` 推送。

```json
{
  "password": "仅本次连接使用",
  "rememberPassword": false
}
```

### `POST /hosts/:id/disconnect`

请求 `{ "stopRemote": false }`。`stopRemote=true` 或该主机策略为 `stop` 时同时停止远端 web。

### `POST /hosts/:id/reconnect`

等价于 disconnect（不停远端）+ connect。

### `POST /hosts/:id/fingerprint`

```json
{ "accept": true, "remember": true, "sha256": "SHA256:xxx" }
```

`sha256` 可选：提供时必须与待确认值一致。`remember && accept` 时写入 `pinnedFingerprint`。

### `POST /hosts/:id/conflict`

响应「远端已有手工启动的 DSH」提示：

```json
{ "action": "stop" }
```

- `stop`：停止检测到的手工进程，继续启动受管实例。
- `alongside`：保留手工实例，另起受管实例，并在 `HostView.warning` 提示共享 `~/.dsh`。
- `cancel`：中止连接，错误码 `remote-dsh-running`。

仅在 `status === 'conflict-pending'` 且 `conflict` 非空时有效；超时（默认 120s）按 `cancel` 处理。

### `POST /hosts/:id/password`

记住或忘记该主机的 SSH 密码。值写入 DSH 凭据存储（插件自有记录空间），**不写 `hosts.json`**。

请求 `{ "password": "..." }` 或 `{ "clear": true }`。
响应 `{ "ok": true, "available": boolean, "saved": boolean }`；`available:false` 表示当前组合没有凭据存储。

### `GET /hosts/:id/open`

仅在 `status === 'connected'` 时可用：

```json
{ "ok": true, "url": "http://127.0.0.1:54321/?token=...", "localPort": 54321, "address": "127.0.0.1:54321" }
```

URL 直接交给桌面端 guest；`?token=` 只用一次完成 cookie 种入，之后由远端重定向到干净地址。

### `POST /hosts/:id/keepalive`

```json
{ "keepAlive": "keep", "idleMinutes": 15 }
```

`keepAlive` ∈ `keep | stop | idle`；`idleMinutes` 会被限制在 1–1440。响应 `{ "ok": true, "host": HostView }`。

### `POST /hosts/:id/activate`

设置当前活动主机（客户端打开面板前调用）。无请求体，返回 `{ "ok": true }`。

### `POST /hosts/:id/diagnose`

执行 9 项检查（可能需要数秒）：

```json
{
  "ok": true,
  "report": {
    "summary": "ok",
    "checks": [
      {
        "id": "ssh-reachable",
        "title": { "zh": "SSH 可达性", "en": "SSH reachability" },
        "status": "pass",
        "detail": { "zh": "...", "en": "..." }
      }
    ],
    "redacted": true,
    "generatedAt": "2026-11-14T00:00:00.000Z",
    "logs": ["..."],
    "serverStatus": 200
  }
}
```

检查项顺序固定：`ssh-reachable`、`auth`、`host-key`、`tunnel`、`remote-service`、`remote-ui`、`remote-version`、`model-credentials`、`desktop-guard`。

### `POST /settings`

局部更新设置：`{ "patch": Partial<SettingsView> }` → `{ "ok": true, "settings": SettingsView }`。

### `POST /local-version`

客户端把页面里读到的本机 DSH 版本回填给 Host（Host 探测失败时的兜底）：
`{ "version": "0.2.2-rc.1" }` → `{ "ok": true }`。

### `POST /active`

```json
{ "id": "h_x" }
```

设置活动主机；`id: null` 清除。返回 `{ "ok": true }`。

## 2. 进度 code

| code | 说明 | params |
|---|---|---|
| `ssh-connecting` | 正在连接 SSH | `host`，跳板机时另有 `jump` / `via` |
| `host-key-confirm` | 等待确认主机指纹 | `sha256` / `keyType` |
| `auth-checking` | 指纹已确认，继续认证 | — |
| `probing` | 正在探测远端环境 | — |
| `remote-dsh-running` | 远端有手工 DSH，等待选择 | `count` |
| `downloading-node` | 正在下载托管 Node | `version` / `mb` |
| `installing-node` | 正在安装托管 Node | `version` |
| `bootstrapping` | 正在准备 npx 运行时 | `level`（恒为 `npx`） |
| `bootstrap-first-run` | 首次运行，下载 DSH 包 | `version` |
| `bootstrap-fetching` | 正在抓取 DSH 依赖 | — |
| `bootstrap-installed` | 依赖安装完成 | — |
| `bootstrap-progress` | 自举输出 | `detail` |
| `starting-remote` | 正在启动/收养远端 DSH | `level` |
| `tunneling` | 正在建立本地回环隧道 | — |
| `verifying` | 正在验证远端界面 | — |
| `ready` | 就绪 | — |
| `reconnecting` | 断线重连中 | `attempt` / `max` |

## 3. 安全约束（客户端必须遵守）

1. 密码只在 `connect` 请求体里出现，不写入客户端存储，不放到 URL。
2. `token` / 带 token 的 URL 只在内存中传递；`GET /open` 的 URL 只交给桌面端 guest。
3. `saveTokens` 默认 false；为 true 时由 Host 在 `$DSH_HOME` 下以 0600 保存，客户端不接触。
4. 所有 `fetch` 使用 `credentials: 'same-origin'` 并带 `x-dsh-remote-go: 1`。
5. guest 只允许 `http://127.0.0.1:<port>`；客户端必须再次校验前缀后才交给桌面端。
6. 跨站请求（Origin 不同或 `sec-fetch-site: cross-site`）必须被拒绝。
