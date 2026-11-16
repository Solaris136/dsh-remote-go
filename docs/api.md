# dsh-remote-go · 本地 Host ↔ Client HTTP API 契约（v2.9）

> Host 插件（`src/`）与 Client 插件（`client.js`）之间的唯一协议，两侧都不得依赖对方的内部实现。
> 基地址 `/dsh-remote-go/api`（挂在本机 DSH Web 服务同源路由下）；JSON 为 `application/json; charset=utf-8`（SSE 除外）。
> 成功 `{ "ok": true, ... }`；失败 `{ "ok": false, "error": ErrorView }`。除 `/health` 与 `/events` 外，所有请求必须带 `x-dsh-remote-go: 1`。
> **准入**：每条请求（`/health` 除外）在进入路由前先过本机 DSH 自己的准入——`Host`/`Origin` 栅栏 + 浏览器会话认证
> （`ctx.connection.requestRejection`），与 DSH 自带路由同一套检查；`/health` 不要求会话，但仍过 Host/Origin 栅栏。
> 内核没有该服务时（旧内核）退回本插件自己的标识头 + 同源栅栏。
> HTTP 状态：成功 200；DSH 准入拒绝 401（会话未认证/失效）或 403（Host/Origin 不通过）；缺头或跨站 403；未知路径 404；`invalid-input` 400；请求体超过 1 MiB 413；`internal` 500；其余业务错误 409。
>
> **v2.0 变更**：移除镜像/工作区相关端点（`GET /local/workspaces`、`GET /hosts/:id/workspaces`、`GET /hosts/:id/mirrors`、`POST /hosts/:id/mirrors/sync`）。主机、连接、诊断与设置端点保持不变。
>
> **v2.1 变更**：`HostView` 增加 `logs`（连接窗口的日志尾），随 `/state` 与 SSE 一起下发；没有新增端点。
>
> **v2.2 变更**：移除客户端未使用的 `POST /hosts/:id/password` 与 `POST /hosts/:id/keepalive`；诊断报告去掉未使用的 `serverStatus` 字段；`keepAlive` / `idleMinutes` 随主机条目一起保存。
>
> **v2.3 变更**：`HostView` 增加 `authKeyPath`（已保存的私钥路径，供编辑表单预填；它不是秘密）。
> 本插件不写远端 `~/.dsh`：没有同步端点，也没有 `sync` 字段。
>
> **v2.4 变更**：新增 `GET /hosts/:id/file?path=<绝对路径>`，把远端文件按原始字节交还给客户端；
> 供远端文件树的“下载”菜单使用（桌面 guest 会话禁止 Chromium 自带下载）。
> 只接受绝对 POSIX 路径，错误码 `remote-file-unavailable`。
>
> **v2.5 变更**：新增下载任务 `POST /downloads`、`GET /downloads/:id/status`、
> `DELETE /downloads/:id`；SSE 增加 `download` 事件。`GET /hosts/:id/file` 与
> `GET /downloads/:id` 只存在于 v2.5，已在 v2.6 移除。
>
> **v2.6 变更**：下载统一改为 Host 流式写入本地目录，不再提供二进制下载端点
> `GET /hosts/:id/file` 与 `GET /downloads/:id`；`POST /downloads` 对文件和文件夹都要求
> `destination`，并直接返回实际写入路径。单文件与文件夹都不设大小/数量上限。
>
> **v2.7 变更**：`GET /hosts/:id/open` 增加同源 `webUrl`，供浏览器半端在
> `/dsh-remote-go/remote/<hostId>/` 承载远端界面；新增该前缀下的同源反向代理（含
> WebSocket 升级）。桌面 half 继续使用 `url` 的回环地址，接口向后兼容。
>
> **v2.8 变更**：`ConnectLogEntry` 增加 `phase`（写下该行时所在的连接阶段）、可选 `text`
> （双语行：边界行与失败原因 / 建议）与可选 `boundary`（本次连接第一行）；`HostView.logs`
> 的语义变为**每次连接开始时重置**（手动连接 / 重连 / 自动重连），第一行是带次数与时间的
> 边界行，失败被写成多行 `error` 级日志。`phase` 恒下发（边界行与首个阶段前的输出为
> `null`），`text` / `boundary` 可选：旧 Host 响应没有 `phase` 时 Client 不渲染阶段标签、
> 按 `message` 原样显示；新 Host 响应给旧 Client 时，`message` 仍是可读的英文兜底。没有
> 新增端点，其余字段与端点不变。
>
> **v2.8 鉴权注记**（同一版本内的准入收紧，端点与字段仍不变）：每条请求在进入路由前先过本机 DSH
> 自己的准入（`ctx.connection.requestRejection`：Host/Origin 栅栏 + 浏览器会话），拒绝为 **401**
> （会话未认证/失效，写在 `ErrorView.code = invalid-input` 里，状态码区分）或 **403**（Host/Origin
> 不通过、缺标识头、跨站）。`/events` 现在**需要浏览器会话凭据**（之前只校验 Origin）；`/health`
> 只豁免会话、仍过 Host/Origin 栅栏；其余 JSON 路由与 `/dsh-remote-go/remote/<hostId>/` 代理路径
> （含每主机一条的 `remote.mux` 升级）走同一套准入。内核没有 Connection 服务时退回本插件原来的
> 标识头 / 同源栅栏，行为与 v2.7 一致。
>
> **v2.8 重启与重挂**：新增 `POST /hosts/:id/restart`（本地主动重启受管远端 DSH）；SSE 增加
> `remote-unreachable` 事件（远端自重启的「疑似 / 确认 / 恢复」）；`RemoteView` 增加 `viewRev`，
> 承载方据此重新导航；`SettingsView` 增加 `remoteHeartbeat`；诊断报告增加 `restarts`；新增错误码
> `remote-unreachable` 与 `restart-unavailable`。`POST /hosts/:id/connect` 在一次性动作进行中返回
> `reason: "already-restarting"`。上述新路由与代理路径同样通过本机 DSH 的准入（v2.8 鉴权注记）。
>
> **v2.9 变更**：新增 `POST /hosts/:id/stop-remote`（关闭本连接管理的远端 DSH：停掉绑定的进程 → 关隧道 →
> 释放 SSH → 主机留在 `disconnected`，配置与凭据保留、不自动重连）与进度码 `stopping-remote`、错误码
> `stop-unavailable`。它与既有的 `POST /hosts/:id/disconnect` 的区别见端点小节：`disconnect` 按存活策略收尾、
> 不做 kill 归属校验；`stop-remote` 是显式破坏性动作，只有本连接启动或接管的那个 pid 能停，且会清掉远端
> `run/web.json`。语义变化只在新增路由与新增 code，`HostView` / `RemoteView` 字段不变。
>
> **v2.9 安全修正**（独立安全审计结论，端点集合不变，与 stop-remote 同一版发布）：`ErrorView` 统一脱敏并
> 限长（§0）；HTTP 状态改为 `invalid-input` 400、请求体过大 413、`internal` 500、其余业务错误 409；
> `Origin` 比较改为回环等价（`127.0.0.1` / `localhost` / `[::1]`），用 `localhost` 打开 GUI 不再「能读不能写」；
> `/health` 收敛为 `{ "ok": true }`；`/diagnostics/self` 与 `/keyfile/list` 不再回显机器路径（越界为 400）；
> 主机 `id` 只由 Host 签发；`/settings` 与当前值深合并；`/local-version` 只回填缺失版本且不低于 `engines.dsh`
> 下限；`POST /downloads` 的 `destination` 限用户主目录且拒绝系统/自启动/凭据目录；同源代理改为请求头白名单 +
> 响应头阻止列表、`Location` 只允许折回远端自身、上游 30s 超时、cookie jar 有上限（`Secure` 不入 jar）；
> `StateView` / `HostView` 增加 `storeCorrupt`（`hosts.json` **内容**不可解析时备份为 `.corrupt-<stamp>`；读取错误不改名，成功写回后标记清除）。

## 0. 通用类型

```ts
type I18nText = { zh: string; en: string }  // 服务端只回结构化文本，客户端按当前语言选择

interface ErrorView {
  code: string
  title: I18nText
  detail: I18nText
  nextSteps: I18nText[]
  retryable: boolean          // UI 是否显示「重试」
  technical?: string          // 已脱敏并限长（≤1200 个字符）；见下方 ErrorView 说明
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

// `connecting` 同时覆盖首次连接、本地重启远端、远端自重启后的重挂与显式关闭远端：
// 后三者的进度码分别是 `restarting-remote`、`restarting-remote` 与 `stopping-remote`，阶段只走
// start（→ tunnel → verifying），且不重跑 ssh / probe / bootstrap。

interface Progress { code: string; params?: Record<string, string | number> }  // 客户端按 code 查本地文案，params 只用于插值

interface FingerprintView {
  sha256: string              // 标准 OpenSSH 形式 "SHA256:..."
  keyType: string             // 例如 "ssh-ed25519"
  status: 'pending' | 'pinned' | 'changed' | 'observed'
  pinned?: string | null
}

interface ConnectLogEntry {
  seq: number                 // 本次连接内从 1 单调递增（每次连接重置），用于稳定渲染与去重
  at: string                  // ISO 时间戳
  level: 'debug' | 'info' | 'warn' | 'error'
  phase: ConnectPhase | null  // 写下这一行时所在的连接阶段；边界行与首个阶段前的输出为 null
  message: string             // 原始一行（英文兜底：SSH / npx / 远端 stdout / 连接步骤 / 失败行）
  text?: I18nText             // 双语行（连接边界行、失败原因与建议），Client 按 locale 渲染，缺省回退 message
  boundary?: true             // 本次连接的第一行：第 N 次连接 + 时刻
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
  /**
   * 每次成功挂载（首次连接 / 本地重启 / 远端重挂）自增。承载方缓存着上一次的 launch URL 与
   * 会话 cookie，发现 viewRev 变化后必须重新 `GET /hosts/:id/open` 并重新导航。
   * 旧 Host 没有该字段：客户端把它当作 null，只在 URL 变化时重载。
   */
  viewRev: number
}

interface HostView {
  id: string
  name: string
  address: string               // 地址或 ~/.ssh/config 别名
  addressMasked: string         // user@host:port 展示形式
  authType: 'key' | 'password'
  authKeyPath: string | null    // 已配置的私钥路径（不是秘密），供编辑表单预填
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
  /**
   * 连接窗口的日志尾（Client 按 locale 渲染）。仅当 status 是 `connecting` / `fingerprint-pending` /
   * `error` 时非空——也就是屏幕上确实有连接窗口的时候；其余状态为 `[]`，避免每帧携带历史日志。
   * **每次连接开始时重置**（手动连接 / 重连 / 自动重连都会），因此这里只有本次连接的行，第一行是带
   * 次数与时间的边界行；最多 120 条，旧的先掉。失败会被写成多行：阶段与错误码、双语原因、每条建议、
   * 脱敏并 `headTail` 截断的技术细节（`remote-dsh-start-failed` 为远端日志尾部逐行）。
   */
  logs: ConnectLogEntry[]
  remote: RemoteView
  keepAlive: 'keep' | 'stop' | 'idle'
  idleMinutes: number           // 1–1440
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
  /**
   * `hosts.json` 的内容在加载时不可解析（已备份为 `hosts.json.corrupt-<stamp>`，并回落到空列表）。
   * 与 `StateView.storeCorrupt` 同值：主机列表为空时只有状态里能看到，所以两个位置都下发；成功写回后清零。
   */
  storeCorrupt: boolean
}

interface DownloadJobView {
  id: string
  hostId: string
  path: string
  name: string                 // 最终本地文件名或文件夹名（含自动重命名后缀）
  kind: 'file' | 'folder' | null
  phase: 'preparing' | 'ready' | 'error'
  totalBytes: number           // 远端总字节；枚举完成前为 0
  doneBytes: number
  totalFiles: number           // 文件夹的文件数；单文件为 1（读完前可为 0）
  doneFiles: number
  destination: string | null   // 实际写入的本机文件/目录绝对路径
  startedAt: string
  error: ErrorView | null
}

interface SettingsView {
  defaultPort: number
  defaultAuth: 'key' | 'password'
  defaultKeyPath: string        // 默认 ~/.ssh/id_rsa
  connectTimeoutSec: number
  autoReconnect: { enabled: boolean; maxAttempts: number; baseDelayMs: number }
  /**
   * 已连接主机的轻量探活。连续两次失败才会触发远端重挂（§5.6）；默认开启、30s。
   */
  remoteHeartbeat: { enabled: boolean; intervalSec: number }  // intervalSec 5–600
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
  hosts: HostView[]; settings: SettingsView
  activeHostId: string | null; firstRun: boolean  // hosts.length === 0
  storeCorrupt: boolean         // hosts.json 内容不可解析、已备份为 .corrupt-<stamp>，主机列表为恢复后的空列表；成功写回后清除
}
```

### ErrorView 脱敏（v2.9 修正）

`ErrorView` 在序列化前**统一**过 `redactObject`：`technical`（常是远端进程输出，第一行就是带 token 的
launch URL）、`detail`、`nextSteps` 里的 token / 密码 / 私钥 / `Authorization` / cookie / home 目录都会被脱敏；
`technical` 还会截断到 1200 个字符（UTF-16 码元，CJK 时 UTF-8 字节更多；保留首尾）。因此它可以安全地进 UI 与日志，但**不是**「原始技术细节」：
排障要看完整输出请取诊断包（`POST /hosts/:id/diagnose`）。

### ErrorView.code

| code | 分类 | 可重试 |
|---|---|---|
| `network` | 网络不可达 | ✅ |
| `auth` | SSH 认证失败 | ✅ |
| `host-key-changed` | 主机指纹变化 | ❌ |
| `host-key-unknown` | 首次连接，等待/超时未确认 | ✅（确认后） |
| `remote-dsh-missing` | 托管 Node 安装失败 / 远端无法运行 npx | ✅ |
| `remote-node-install-failed` | 远端 Node 自动安装失败 | ✅ |
| `remote-dsh-start-failed` | 远端 DSH 启动失败 | ✅ |
| `remote-dsh-running` | 手工 DSH 冲突且用户取消/停止失败 | ✅ |
| `remote-ui-unreachable` | 隧道或远端界面校验失败 | ✅ |
| `remote-unreachable` | 远端自己重启后找不到可重挂实例（主机与配置保留） | ✅ |
| `restart-unavailable` | 非可重启状态（未连接 / SSH 已释放 / 动作进行中）请求重启 | ✅ |
| `stop-unavailable` | 非可关闭状态（未连接 / SSH 已释放 / 动作进行中）或远端 pid 无法证明归属时请求关闭远端 | ✅ |
| `remote-file-unavailable` | 远端文件/文件夹不存在、不可读或超过下载上限 | ✅ |
| `download-not-ready` | 下载任务尚在准备、已失败或已过期 | ✅ |
| `download-busy` | 同时准备/保留的下载任务过多 | ✅ |
| `version-mismatch` | npx 回读版本与本机不一致 | ✅ |
| `unsupported-os` | 远端系统不支持 | ❌ |
| `invalid-input` | 参数不合法 | ❌ |
| `internal` | 插件内部错误 | ✅ |

## 1. 端点

### `GET /health`（无需浏览器会话，仍过 Host/Origin 栅栏）
存活探针，不返回任何状态数据，因此不要求 DSH 浏览器会话；`Host` 仍必须是本机 origin，`Origin`（若有）必须同源。
响应只有 `{ "ok": true }`：这条路由不需要会话，也就不下发版本、时间或任何可被无会话调用方读到的字段。

### `GET /state`
```json
{ "ok": true, "state": StateView }
```

### `GET /events`（SSE，DSH 准入 + Origin/Host 栅栏）
`text/event-stream`：连接后立即推一帧 `state`，随后状态变化时推送，每 15s 一次 `ping`。EventSource 无法设置自定义请求头，因此该路由先过 DSH 准入（Host/Origin 栅栏 + 浏览器会话），再过本插件的 Origin / Host 同源 / 非 cross-site 栅栏；没有会话的调用方在开流前就被拒绝（401），DNS rebinding 的调用方因 `Host` 不是本机 origin 被拒绝（403）。
```text
event: state
data: { ...StateView }

event: download
data: { ...DownloadJobView }

event: remote-unreachable
data: { "hostId": "h_x", "phase": "suspected" | "confirmed" | "recovered",
       "source": "proxy" | "tunnel" | "heartbeat", "failures": 2, "at": "…" }

event: ping
data: {}
```

`download` 只在下载任务启动、进度变化、完成或失败时推送；客户端仍应在收到 `POST /downloads` 后轮询 `/status` 一次，避免 EventSource 尚未订阅时漏帧。
`remote-unreachable` 只在远端自重启的**一次**事件里推送最多三帧：`suspected`（第一次失败 / 代理故障，尚在确认）、`confirmed`（连续两次探活失败，开始重挂）、`recovered`（探活恢复）。若故障来源是代理/隧道，同一个 recovered 之前会先问本地监听器：能应答就不动；不应答才重建 listener（先建新、再关旧，失败按 30s→120s 退避）。重建会把 `RemoteView.viewRev` 自增（本地回环端口变了），承载方据此重新 `GET /hosts/:id/open` 并导航；关闭旧 listener 会短暂断开现有 WebSocket 与下载，属预期。同一类疑似上报在 recovered 后 15s 内不重复开新事件。重挂过程本身通过 `state` 的 `restarting-remote` 进度表达，客户端不需要依赖该事件才能恢复。拿不到新 launch token 的远端（例如日志被 supervisor 重定向）不会被接管，而是以 `remote-unreachable` 结束并保留主机、配置与 SSH。

### `GET /version`
```json
{ "ok": true, "version": "0.1.0", "apiVersion": "2.9", "hostVersion": "0.2.2-rc.1" }
```

### `GET /diagnostics/self`
返回插件入口与 client-module 图行，用于验收/排障（`home` / `stateDir` 等机器路径与用户名同样过脱敏，
`storeCorrupt` 表示 `hosts.json` 被隔离过）：
```json
{ "ok": true, "plugin": { "id": "dsh-remote-go", "version": "0.1.0" }, "at": "…",
  "home": "C:\\Users\\<user>", "stateDir": "C:\\Users\\<user>\\.dsh\\remote-go", "storeCorrupt": false,
  "hostVersion": "0.2.2-rc.3", "engineNodeRange": ">=24.9.0",
  "entry": { "id": "dsh-remote-go", "name": "dsh-remote-go" },
  "client": { "graph": { "rev": "…", "release": { }, "entries": 1 }, "row": { }, "clientPath": "…", "bundle": { } } }
```

### `GET /ssh/aliases`
只读扫描本机 `~/.ssh/config` 与 `~/.ssh/known_hosts`：
```json
{ "ok": true, "aliases": [{ "alias": "my-server", "host": "192.0.2.10", "user": "ubuntu", "port": 22, "source": "config" }],
  "knownHosts": { "entries": 12, "hashed": 0, "hosts": ["github.com"] } }
```

### `GET /keyfile/list?path=<dir>`
只读目录浏览，供客户端选择私钥文件；范围限用户主目录内，拒绝 `..` 与符号链接逃逸。越界或不可读的目录是
调用方的输入问题：返回 **400** `invalid-input`（字段 `path`），响应里**不回显**请求的路径。
```json
{ "ok": true, "path": "C:\\Users\\me\\.ssh", "parent": "C:\\Users\\me",
  "entries": [{ "name": "id_rsa", "path": "C:\\Users\\me\\.ssh\\id_rsa", "isDirectory": false }],
  "truncated": false, "defaultKeyPath": "~/.ssh/id_rsa", "defaultDir": "C:\\Users\\me\\.ssh" }
```

### `POST /hosts`
新增或更新主机（带**已存在的** `id` 为更新）。`id` 由 Host 签发（`h_*`）：客户端传来的未知 id 或格式
不合法的 id 会被替换成一个新的 id，不会被采纳（`id` 同时是 secrets 键与代理路由的一部分，不能让调用方
伪造或占用别人的条目）。认证只有私钥文件或密码；`auth.type="key"` 省略 `keyPath` 时用
`SettingsView.defaultKeyPath` 补齐；密码不经此接口传输。`keepAlive` / `idleMinutes` / `autoReconnect` /
`hostKeyPolicy` 也随主机条目一起保存（不再有单独的 keepalive 端点）。
```json
{ "host": { "id": "h_xxx", "name": "构建服务器", "address": "my-server", "port": 22, "username": "ubuntu",
  "auth": { "type": "key", "keyPath": "~/.ssh/id_rsa" }, "jumpHost": null, "keepAlive": "keep",
  "idleMinutes": 15, "autoReconnect": true, "hostKeyPolicy": "first-use" } }
```
`keepAlive` / `idleMinutes` / `autoReconnect` / `hostKeyPolicy` 编辑时省略表示保留原值。响应
`{ "ok": true, "host": HostView }`；校验失败返回 `invalid-input`（400）。

### `DELETE /hosts/:id`
断开（按存活策略决定是否停远端）并删除记录，同时取消该主机所有计时器。响应 `{ "ok": true }`。

### `POST /hosts/:id/connect`
异步发起连接：立即返回 `{ "ok": true, "accepted": true }`；已在连接 / 已连接 / 正在重启远端时返回 `{ "ok": true, "accepted": false, "reason": "already-connecting" | "already-connected" | "already-restarting" }`。进度经 `/events` 推送。`rememberPassword: true` 时密码在连接成功后写入 DSH 凭据存储（`passwordSaved` 只表示是否已保存，永不返回值）。
```json
{ "password": "仅本次连接使用", "rememberPassword": false }
```

### `POST /hosts/:id/disconnect`
请求 `{ "stopRemote": false }`；`stopRemote=true` 或该主机策略为 `stop` 时同时停止远端 web。响应 `{ "ok": true }`。
这是「断开连接」的收尾路径：按存活策略处理（`keep` 只关隧道、`idle` 保留 SSH 稍后停、`stop` 停远端），
停止远端时直接使用当前记录的 pid，**不做归属校验**。显式、可审计地「关掉这台远端 DSH」请用下面的
`stop-remote`。

### `POST /hosts/:id/stop-remote`
关闭本连接管理的远端 DSH（管理界面卡片上的「关闭远端 DSH」），无请求体，同步执行：

- 语义：在**同一条 SSH 会话**上停掉本连接绑定的那一个远端 web 进程（`stopRemoteWeb`：SIGTERM → 等待 →
  SIGKILL，并删除远端 `run/web.json`）→ 关闭隧道 → 释放 SSH → 主机状态转 `disconnected`；主机配置、凭据与
  存活策略保留，**不触发自动重连**，之后 `POST /hosts/:id/reconnect` 会起一个全新实例（新端口、新 token）。
- 状态机：`connected` ✅；`error` + `error.code === "remote-unreachable"` ✅（该状态保留 SSH 会话；绑定的
  pid 已经消失时只清理残留 registry 再释放连接）；其余状态（`unconfigured` / `disconnected` / `connecting` /
  `fingerprint-pending` / `conflict-pending` / 其它 `error` / `limited`）以及另一个一次性动作进行中时一律拒绝，
  HTTP **409** + `stop-unavailable`，`ErrorView.detail` 说明原因。
- 授权（与 `restart` 同一套 `/proc` 身份证明）：pid 必须就是本连接绑定的那个；本连接必须记录过它（自己启动的，
  或重挂接管的）；远端 `run/web.json` 必须仍命名它且 dshHome / profile 一致；`/proc/<pid>` 的 starttime、
  cmdline 与 `DSH_HOME` 必须仍证明是同一进程。`alongside` 保留的 pid、pid 复用、归属证明不了的一律**不 kill**
  （409 `stop-unavailable`，连接保持原样）。重挂接管的实例（`origin: "reattach"`）**不会被自动或静默停止**：
  显式关闭走本端点（关闭前按 `/proc` 复验身份）；`POST /hosts/:id/restart` 遇到它时会并入冲突提示，由用户选择
  是否停止（那条路径走既有的 `stopForeign`，与本端点的授权是两条独立路径）。
- 执行期间 `/events` 推送 `status: "connecting"` + 进度码 `stopping-remote`（`pid` / `port`），客户端据此禁用
  卡片按钮并显示「正在关闭远端 DSH…」；结束后状态帧直接是 `disconnected`。
- 响应：`{ "ok": true, "pid": 4242 }`（进程在动作前已消失时为 `pid` 仍为该绑定值、实际只清理了 registry）。
  失败返回 409 `stop-unavailable`，连接保持原样以便重试或「重连」。这里的「失败」只表示 `stopRemoteWeb` 的 SSH
  退出码非 0（脚本内部 `kill||true` + `echo STOPPED`，D 状态进程等真正没死的情况仍会假成功；`kill -0` 复核是
  后续项）。

### `POST /hosts/:id/reconnect`
等价于 disconnect（不停远端）+ connect。响应 `{ "ok": true }`。

### `POST /hosts/:id/restart`
本地主动重启受管远端 DSH，仅 `status === "connected"` 时可用；另有一个恢复入口：远端重挂失败后的
`error` + `error.code === "remote-unreachable"` 状态（该状态按 §5.6 保留 SSH 会话）也可以用同一个端点重启。
语义：在同一条 SSH 会话上停掉本连接启动的进程（run registry 里的 pid，SIGTERM → 等待 → SIGKILL）→ 重新
`[start]`（`--port 0`，端口与 token 必变）→ 刷新远端 `run/web.json` → 关旧隧道并按新端口重建 →
`[verifying]` → `connected`。**不重跑** `[ssh]` / `[probe]` / `[bootstrap]`，不会再次索要密码或主机指纹；
结束后仍按原 `keepAlive` 策略。

- 异步执行：立即返回 `{ "ok": true, "accepted": true }`，进度经 `/events` 推送（`status: "connecting"` + 进度码 `restarting-remote`）。已有连接 / 重启在进行时返回 `{ "ok": true, "accepted": false, "reason": "busy" }`。
- 状态机：`connected` ✅；`error` + `error.code === "remote-unreachable"` ✅（该状态有意保留 SSH 会话）；其余状态（`unconfigured` / `disconnected` / `connecting` / `fingerprint-pending` / `conflict-pending` / 其它 `error` / `limited`）一律拒绝，HTTP **409** + `restart-unavailable`，`ErrorView.detail` 说明原因。
- 只杀自己启动的实例：同时满足「run registry 命名该 pid」「本连接实际启动过它（start 脚本返回的 pid，或 adopt 自 `origin: "launch"` 记录）」「`/proc/<pid>` 的 starttime 与记录一致且 cmdline/env 仍是同一 DSH home/profile」才会 kill；pid 复用、重挂发现的 pid、`alongside` 保留的 pid 一律不 kill。本连接无法 kill、但仍存活且不是 alongside 的实例（典型是重挂发现的监听进程）会并入 `POST /hosts/:id/conflict` 的冲突提示（`stop` / `alongside` / `cancel`），在用户选择前**不会启动第二个实例**；外部扫描失败时同样先把已知实例交给冲突提示，不会 fail-open。冲突提示在 kill 之前，取消时保留当前连接与隧道。
- 受管实例的停止没有确认（`stopWeb` 返回 `ok:false`）时**不会**继续启动新实例：保留原连接与隧道，`HostView.warning` 给出可解释文案，用户可重试或先断开。
- 未连接（或 SSH 已释放）时返回 409 `restart-unavailable`。
- 成功后 `RemoteView.viewRev` 自增，旧 `url` / `webUrl` 与 token 失效；承载方应重新 `GET /hosts/:id/open` 并导航。

### `POST /hosts/:id/fingerprint`
```json
{ "accept": true, "remember": true, "sha256": "SHA256:xxx" }
```
`sha256` 可选，提供时必须与待确认值一致；`remember && accept` 时写入 `pinnedFingerprint`。

### `POST /hosts/:id/conflict`
响应「远端已有手工启动的 DSH」提示：`{ "action": "stop" }`。

- `stop`：停止检测到的手工进程，继续启动受管实例。
- `alongside`：保留手工实例，另起受管实例，并在 `HostView.warning` 提示共享 `~/.dsh`。
- `cancel`：中止连接，错误码 `remote-dsh-running`。

仅在 `status === 'conflict-pending'` 且 `conflict` 非空时有效；超时（默认 120s）按 `cancel` 处理。

### `GET /hosts/:id/open`
仅 `status === 'connected'` 时可用：
```json
{ "ok": true,
  "url": "http://127.0.0.1:54321/?token=...",
  "webUrl": "/dsh-remote-go/remote/h_xxx/?token=...",
  "localPort": 54321,
  "address": "127.0.0.1:54321" }
```
- `url` 是远端界面的回环地址，交给桌面端的 Chromium guest；`token` 只用一次完成 cookie 种入，之后由远端重定向到干净地址。
- `webUrl` 是同一界面的**同源**地址，交给浏览器半端的 iframe：`/dsh-remote-go/remote/<hostId>/` 由本机 DSH 的
  反向代理转发到该主机的回环隧道（见下文「远端界面同源代理」）。`token` 同样只在首次导航里出现一次；代理随后把远端的
  session cookie 收进 Host 侧，不交给浏览器。
- 两个地址都绑定这一次连接；断开、重连、本地重启或远端重挂后旧 URL 失效（`RemoteView.viewRev` 变化即为信号）。

### 远端界面同源代理（`/dsh-remote-go/remote/<hostId>/`）
浏览器半端没有 guest 能力，故远端界面以同源 iframe 承载。该前缀**不是** JSON API，也不属于 `API_PREFIX`：
- 前缀路由把 `/<hostId>/<rest>` 去掉前缀后转发到**该主机当前隧道**的 `/<rest>`（含 query）；
  `<hostId>` 必须是已知且 `connected` 的主机，否则 404；未连接 / 未知 id 不产生上游连接。
- 浏览器不给代理带任何插件请求头（iframe 导航、子资源与 WebSocket 都不可加）；代理改用与本地 API 相同的
  浏览器信任栅栏：`Host` 必须是本机 origin（回环写法等价）、`Origin`（若有）必须同源、`sec-fetch-site`
  不能是 `cross-site`，否则 403。
- 远端 `Set-Cookie` 由 Host 侧的 per-host cookie jar 保存，并从响应里移除；后续请求与 WebSocket 升级由 jar
  注入。因此本地 DSH 的 cookie 与远端 DSH 的 cookie 虽然同在 `127.0.0.1` 上，也永不混用。jar 有上限
  （每主机 ≤64 条、cookie 值 ≤4 KiB），`Secure` cookie 不进这个明文 jar（隧道就是 loopback 明文 HTTP）。
- 请求头是**白名单**：只转发 `accept`、`accept-encoding`、`accept-language`、`content-type`、
  `content-length`、`range`、`if-*`、`cache-control`、`user-agent`、`x-requested-with`，WebSocket 升级另加握手头。
  本机会话的 `authorization` / `cookie` / `x-dsh-*`、一跳字段 `forwarded` / `x-forwarded-*` 与 `sec-fetch-*`
  **一律丢弃**，不会到达远端（`x-dsh-remote-go` 是常量标识头，不是凭据，但同样不转发）。
- 转发时 `Host` / `Origin` 改写为该远端自己的回环 authority（`127.0.0.1:<远端 web 端口>`），远端的
  authority 绑定 cookie 与同源校验继续成立；`Location` 指回远端自身 listener 时折回
  `/dsh-remote-go/remote/<hostId>/`，**其它绝对地址（外部域、`//host`、其它 loopback 端口、`javascript:`）
  直接丢弃**；一个“相对”引用里只要还带反斜杠也丢弃（http(s) 下 `/\evil`、`\/evil` 都会被浏览器解析成外站
  origin），`#` / `/` / `.` 开头且不含反斜杠的相对引用原样透传。
  响应去掉 `X-Frame-Options`，并从 CSP 中只移除 `frame-ancestors` 指令（其余指令原样保留），因为这条代理的存在意义
  就是把这一页嵌进同源 frame。
- 响应头按名丢弃 `clear-site-data`、`access-control-*`、`refresh`、`content-location`、`report-to`、
  `nel`、`permissions-policy`、`alt-svc`：远端不得通过本机 origin 清本地 cookie / 存储或改写浏览器策略。
  **WebSocket 的 101 响应头同样过这套策略**（只解析响应头，帧原样流转；`Connection` / `Upgrade` /
  `Sec-WebSocket-*` 保留），因此远端也不能借握手把 `Set-Cookie` 或策略头塞给浏览器。
- 上游 30s 内没有响应头（连接已建立但对端不回答）即 **502**，并同时销毁两侧连接；升级握手同样有 30s 超时。
  已建立的响应流不受该超时影响（SSE / 大文件可以合法地长时间空闲）。
- 远端 DSH 唯一的 WebSocket 路由 `/api/remote.mux` 以**每主机一条精确升级路由**的形式注册
  （`/dsh-remote-go/remote/<hostId>/api/remote.mux`），Host 卸载或主机被删除时注销。
- 上游不可达时返回 502 文本；代理只读、不写远端文件，也不缓存响应。上游连接失败会向 Host 上报一次
  `remote-unreachable` 疑似事件（不把单次 502 当成远端重启；Host 用探活确认后再重挂）。

> 同源 iframe 的威胁模型（「远端被入侵 = 本机 API 被可信调用」）见
> [docs/design.md](design.md) §7.1：这条代理只降低「远端在同源上多做一步」的面，不构成对恶意远端的隔离。

### `POST /downloads`
启动一个后台下载任务（文件或文件夹），立即返回初始 `DownloadJobView`（`phase: "preparing"`）。Host 把远端内容**流式写入用户选择的本机目录**，不在内存里缓存文件字节；进度通过 SSE `download` 事件推送，也可用 `/status` 兜底轮询。

```http
POST /dsh-remote-go/api/downloads
x-dsh-remote-go: 1
content-type: application/json
{ "hostId": "h_xxx", "path": "/home/ubuntu/project", "destination": "C:\\Users\\me\\Downloads" }
```
```json
{ "ok": true, "job": { "id": "dl_...", "phase": "preparing", "...": "..." } }
```

约束：

- `path` 必须是绝对 POSIX 路径；Host 会 `stat` 判断文件或文件夹。
- **不设置文件或文件夹大小上限，也不限制文件个数。**
- `destination` 必填（DSH 目录选择器 `uiWorkspace.pickDirectory` 返回的绝对本机目录），并且：
  - 必须在**本机用户主目录之下**；`Startup` / `autostart` / `systemd`、`Start Menu\Programs` 等自启动位置、
    `.ssh` / `.gnupg` 等凭据目录、`.bashrc` / `.profile` / `.config` / `.local` 等登录脚本与配置目录、系统目录与
    `shell:` 形式的路径一律拒绝（`invalid-input` + 字段 `destination`）。原因见
    [docs/design.md](design.md) §7.1：这个字段是「远端决定写什么、写到哪里」的写入口。
  - **远端命名的最终路径也受同一策略约束**：`destination` 合法不代表 `destination/<远端名字>` 合法。远端文件夹名
    `autostart`、`Startup`、`.ssh`，远端文件名 `.bash_login`，或会在其下生成受保护路径的上级目录（例如
    `AppData/Roaming/Microsoft`）同样返回 `invalid-input`，且**不发生任何写入**。
  - 校验是**同步**的：坏 `destination` 直接 400，不会先创建 `preparing` 任务再异步报错。
  - 文件：写入 `<destination>/<远端文件名>`；同名文件已存在时改用 `<名字> (2).<扩展名>`、`<名字> (3).<扩展名>`……
  - 文件夹：在 `destination` 下新建 `<远端文件夹名>`；同名文件夹或文件已存在时改用 `<名字> (2)`、`<名字> (3)`……
- 文件夹不打包 ZIP：Host 递归枚举后逐个文件写到新建目录，保留子目录与空目录，跳过符号链接。
- 所有文件都从 SFTP 直接写入本地文件；取消会销毁流并删除本次未完成的文件/目录。
- 同一时刻最多 2 个任务在准备、最多保留 4 个任务；超出返回 `download-busy`（HTTP 409）。

### `GET /downloads/:id/status`
返回 `{ "ok": true, "job": DownloadJobView }`。任务不存在或过期时返回 `download-not-ready`（409）。

### `DELETE /downloads/:id`
取消并释放任务，返回 `{ "ok": true }`；任务已不存在也返回成功（幂等）。

### `POST /hosts/:id/activate`
设置当前活动主机（客户端把窗口交给这台时调用）。无请求体，返回 `{ "ok": true }`。

### `POST /hosts/:id/diagnose`
执行 10 项检查（可能需要数秒）：
```json
{ "ok": true, "report": { "summary": "ok",
  "checks": [{ "id": "ssh-reachable", "title": { "zh": "SSH 可达性", "en": "SSH reachability" },
    "status": "pass", "detail": { "zh": "...", "en": "..." } }],
  "restarts": [{ "at": "…", "kind": "local-restart" | "remote-reattach",
                 "fromPort": 38123, "toPort": 41234, "pid": 4242,
                 "reason": "probe-failed-2", "source": "registry" | "log" }],
  "redacted": true, "generatedAt": "2026-11-14T00:00:00.000Z", "logs": ["..."] } }
```
报告恒为脱敏（`redacted: true`），`logs` 是最多 40 条已脱敏的连接日志；`summary` ∈ `ok | warning | error`。
`restarts` 是最近最多 10 次本地重启 / 远端重挂（`toPort` 是新端口，`reason`/`source` 说明重挂依据）。
检查项顺序固定：`ssh-reachable`、`auth`、`host-key`、`tunnel`、`remote-service`、`remote-ui`、`remote-node`、`remote-version`、`model-credentials`、`desktop-guard`。

### `POST /settings`
局部更新设置：`{ "patch": Partial<SettingsView> }` → `{ "ok": true, "settings": SettingsView }`。
patch 与**当前生效值**深合并（不是与默认值合并），因此 `{ "autoReconnect": { "maxAttempts": 12 } }` 只改这一个
字段，不会把 `baseDelayMs` 之类的兄弟字段重置回默认值。

### `POST /local-version`
客户端把页面里读到的本机 DSH 版本回填给 Host（只在 Host 探测失败时的兜底）：
`{ "version": "0.2.2-rc.3" }` → `{ "ok": true, "accepted": true }`。
- Host 已经探测到版本时**不覆盖**，返回 `{ "ok": true, "accepted": false }`。
- 低于 `package.json` `engines.dsh` 下限（当前 `0.2.2-rc.3`）或不是合法 semver 时，返回 **400**
  `invalid-input`（字段 `version`），不改变现有版本。远端 npx 运行时被钉在这个版本上，不能让页面随意指定。

### `POST /active`
`{ "id": "h_x" }` 设置活动主机，`id: null` 清除；返回 `{ "ok": true }`。

## 2. 进度 code

- `ssh-connecting`（`host`，跳板机另有 `jump` / `via`）、`host-key-confirm`（`sha256` / `keyType`）、`auth-checking`、`probing`
- `remote-dsh-running`（`count`）、`downloading-node`（`version` / `mb`）、`installing-node`（`version`）、`bootstrapping`（`level`，恒为 `npx`）
- `bootstrap-first-run`（`version`）、`bootstrap-fetching`、`bootstrap-installed`、`bootstrap-progress`（`detail`）
- `starting-remote`（`level`）、`tunneling`、`verifying`、`ready`、`reconnecting`（`attempt` / `max`）
- `restarting-remote`（`reason`，可选 `pid` / `port` / `level`）：本地重启远端或远端自重启后的重挂；状态保持
  `connecting`，阶段只走 `start` → `tunnel` → `verifying`
- `stopping-remote`（可选 `pid` / `port`）：显式关闭远端 DSH；状态保持 `connecting`，只走 `start` 阶段，
  结束后直接是 `disconnected`，不会进入 `tunnel` / `verifying`

## 3. 安全约束（客户端必须遵守）

1. 密码只在 `connect` 请求体里出现，不写入客户端存储，不放到 URL。
2. `token` / 带 token 的 URL 只在内存中传递；`GET /open` 的 `url` 只交给桌面端 guest，`webUrl` 只交给同源 iframe。
   两者都只用于首次导航，客户端不得持久化、不得拼进其它请求。
3. `saveTokens` 默认 false；为 true 时由 Host 在 `$DSH_HOME` 下以 0600 保存，客户端不接触。
4. 所有 `fetch` 使用 `credentials: 'same-origin'` 并带 `x-dsh-remote-go: 1`。
5. guest 只允许 `http://127.0.0.1:<port>`；浏览器 iframe 只允许 `/dsh-remote-go/remote/<hostId>/` 形状的
   同源路径（拒绝绝对 URL、`//`、转义与路径穿越），两端都在交给承载器前再校验一次。
6. 每条请求先过本机 DSH 的准入（Host/Origin 栅栏 + 浏览器会话）；内核没有 Connection 服务时退回本插件自己的栅栏。
7. `Host` 必须是本机监听 origin：DNS rebinding 下浏览器会带上攻击者的域名，这是唯一能拦下它的检查（`/events` 也只有这一道）。
8. 跨站请求（Origin 不同或 `sec-fetch-site: cross-site`）必须被拒绝；同源代理使用同一栅栏。
9. 代理只服务 `connected` 主机：断开后同一 URL 立即不再有上游；远端的 cookie 只存在 Host 内存里。
