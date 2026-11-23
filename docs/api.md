# dsh-remote-go · 本地 Host ↔ Client HTTP API 契约（v2.12）

> Host 插件（`src/`）与 Client 插件（`client.js`）之间的唯一协议，两侧都不得依赖对方的内部实现。
> 基地址 `/dsh-remote-go/api`（挂在本机 DSH Web 服务同源路由下）；JSON 为 `application/json; charset=utf-8`（SSE 除外）。
> 成功 `{ "ok": true, ... }`；失败 `{ "ok": false, "error": ErrorView }`。除 `/health`、`/events` 与 `/events/logs` 外，所有请求必须带 `x-dsh-remote-go: 1`。
> **准入**：每条请求（`/health` 除外）在进入路由前先过本机 DSH 自己的准入——`Host`/`Origin` 栅栏 + 浏览器会话认证
> （`ctx.connection.requestRejection`），与 DSH 自带路由同一套检查；`/health` 不要求会话，但仍过 Host/Origin 栅栏。
> 内核没有该服务时（旧内核）退回本插件自己的标识头 + 同源栅栏。
> HTTP 状态：成功 200；DSH 准入拒绝 401（会话未认证/失效）或 403（Host/Origin 不通过）；缺头或跨站 403；未知路径 404；`invalid-input` 400；请求体超过 1 MiB 413；`internal` 500；其余业务错误 409。
> 401/403 由准入层直接返回、**没有** `{ok:false,error}` 信封；Client 按状态码把它们显示为「会话已失效，请刷新」
> 与「被安全策略拒绝（Host/Origin）」且不提供重试（`retryable:false`），不再落到「插件内部错误」。
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
> **v2.10 变更**（含独立安全审计的修正，均为向后兼容，与 2.9 的 stop-remote 同处未发布窗口）：
> `StateView` 增加 `rev` / `instance` 与 `storeCorrupt`，`HostView` 增加 `username` / `port` 与 `storeCorrupt`。
> 新字段只增不改，旧 Client 忽略它们；旧 Host 缺少 `rev` / `instance` / `port` / `username` 时新 Client 退回旧行为
> （无版本回退、从 `addressMasked` 反解析编辑字段）。`rev` 只在同一个 `instance` 内单调；Host 进程重启或插件
> 重载会换 `instance`，Client 遇到新代际时接受其帧（即使 `rev` 回退），不会永久卡在旧高水位。
> `addressMasked` 只用于展示：端口 22 省略、IPv6 加方括号（`user@[fe80::1]:2222`）；编辑表单必须读
> `port` / `username`。
>
> **v2.10 安全修正**（#76，独立安全审计结论，端点集合不变）：`ErrorView` 统一脱敏并
> 限长（§0）；HTTP 状态改为 `invalid-input` 400、请求体过大 413、`internal` 500、其余业务错误 409；
> `Origin` 比较改为回环等价（`127.0.0.1` / `localhost` / `[::1]`），用 `localhost` 打开 GUI 不再「能读不能写」；
> `/health` 收敛为 `{ "ok": true }`；`/diagnostics/self` 与 `/keyfile/list` 不再回显机器路径（越界为 400）；
> 主机 `id` 只由 Host 签发；`/settings` 与当前值深合并；`/local-version` 只回填缺失版本且不低于 `engines.dsh`
> 下限；`POST /downloads` 的 `destination` 限用户主目录且拒绝系统/自启动/凭据目录；同源代理改为请求头白名单 +
> 响应头阻止列表、`Location` 只允许折回远端自身、上游 30s 超时、cookie jar 有上限（`Secure` 不入 jar）；
> `StateView` / `HostView` 增加 `storeCorrupt`（`hosts.json` **内容**不可解析时备份为 `.corrupt-<stamp>`；读取错误不改名，成功写回后标记清除）。
>
> **v2.11 变更**：SSH 密码默认保存，并在 DSH 重启后继续复用。`POST /hosts/:id/connect` 的
> `rememberPassword` 默认 **true**：携带的密码在 SSH 认证通过后写入 DSH 凭据存储（不是 `hosts.json`），
> 后续连接（含后台重连与 Host 重启后的首次连接）直接使用；`rememberPassword: false` 只用本次并删除该主机
> 已保存的记录。新增 `POST /hosts/:id/password`（向导的「保存」不连接时也能记住/清除密码）。凭据记录的键
> 改为 DSH 要求的 `<owner>/<id>` 形式（`dsh-remote-go/ssh-password-h-...`）：旧的冒号键会被 DSH 的凭据
> 存储在下一次读取时拒绝，导致整个凭据文件不可用。`HostView.passwordSaved` 现在只表示凭据存储里确实有记录
> （由 Host 启动时读取，内存中的一次性密码不再算已保存）；`StateView` 增加 `passwordStorageAvailable`
> 供向导决定是否显示「记住密码」。切回密钥认证或删除主机时会删除该主机的密码记录。
>
> **v2.12 变更（SSE 拆通道）**：状态与连接日志分成两条 SSE 流。`GET /events` 仍是状态通道（`state` /
> `download` / `remote-unreachable` / `ping`，路径与丢帧规则不变），但**`hosts[].logs` 在状态帧里恒为 `[]`**；
> 连接日志走新增的 `GET /events/logs`，帧带 `hostId` / `attempt` / `seq` 与 `id:`，可用 `Last-Event-ID`
> 续传，不可续时发 `reset` 并重放尾部。`HostView` 增加 `logAttempt` / `logSeq` 两个游标字段（`logAttempt` 只增；
`logSeq` 在**同一次 attempt 内**只增，换 attempt 时随该次连接从 1 重新计数）。
> **日志追加不再改变 `StateView.rev`**：`rev` 只因状态模型变化自增。`GET /state` **仍然**返回每台主机的日志尾，
> 它仍是唯一带日志的权威快照。降级行为（同包发布，两种混跑都可能出现在开发期）：**新 Client + 旧 Host**
> （没有 `/events/logs`）→ 日志流 404 后自动关闭，日志改从 `GET /state` 与状态帧里的 `logs` 得到，不报错、
> 不弹窗；**旧 Client + 新 Host** → 状态帧 `logs` 为空，连接窗口的日志面板为空（**已知降级**），其余一切正常。

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
// 说明（跳板机）：确认提示期间这里展示的是**当前正在确认的那把密钥**。目标与跳板各有自己的
// host-key 上下文：跳板机确认的 pin 只在本次会话内有效（不写 store），配置文件里没有跳板 pin 字段，
// 插件重启后需要重新确认；改 `jumpHost` 后旧跳板 pin 会被丢弃并重新询问（不会报 `host-key-changed`）。
// Client 的对话框按这一份视图渲染，不区分跳板 / 目标，也没有第二套文案——这是本版已知限制。

interface ConnectLogEntry {
  seq: number                 // 本次连接内从 1 单调递增（每次连接重置），用于稳定渲染与去重
  at: string                  // ISO 时间戳
  level: 'debug' | 'info' | 'warn' | 'error'
  phase: ConnectPhase | null  // 写下这一行时所在的连接阶段；边界行与首个阶段前的输出为 null
  message: string             // 原始一行（英文兜底：SSH / npx / 远端 stdout / 连接步骤 / 失败行）
  text?: I18nText             // 双语行（连接边界行、失败原因与建议），Client 按 locale 渲染，缺省回退 message
  boundary?: true             // 本次连接的第一行：第 N 次连接 + 时刻
}

/**
 * `GET /events/logs` 的 `log` 帧（v2.12）。一条流多路复用所有「日志可见」的主机，帧用 hostId 区分。
 * `id:` = `<instance>:<hostId>:<attempt>:<seq>`，重连时由 EventSource 回传为 `Last-Event-ID`。
 */
interface ConnectLogFrame {
  hostId: string
  instance: string           // 发布代际 = StateView.instance；换代际即游标作废
  attempt: number            // 本次连接序号 = 边界行「第 N 次连接」的 N；每次连接开始时 +1
  seq: number                // 游标：本帧最后一行的 seq；本帧为空时等于该主机当前游标
  reset?: true               // 客户端丢弃该主机现有行，用 entries 重建（首帧 / 续传不可用）
  visible: boolean           // false ⇒ 该主机已离开「日志可见」集合，随后会有 log-end
  entries: ConnectLogEntry[] // ≤ 120 行（与 Host 日志尾同一窗口），按 seq 升序
}

/** `GET /events/logs` 的 `log-end` 帧（v2.12）：该主机的这次连接不再有新行。 */
interface ConnectLogEnd {
  hostId: string
  attempt: number
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
  addressMasked: string         // user@host[:port] 展示形式；端口 22 省略，IPv6 用 [host] 括起。只用于展示
  username: string | null       // 明文用户名（非秘密），编辑表单直接使用；旧 Host 没有该字段
  port: number                  // 明文端口（默认 22，非秘密），编辑表单直接使用；旧 Host 没有该字段
  authType: 'key' | 'password'
  authKeyPath: string | null    // 已配置的私钥路径（不是秘密），供编辑表单预填
  passwordSaved: boolean        // 凭据存储里确实有该主机的密码；永不返回值。Host 启动时从存储恢复，不因内存中的一次性密码变真
  passwordStorageAvailable: boolean  // 本机是否有可用的凭据存储（HostView 与 StateView 同值）
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
   * 连接窗口的日志尾（Client 按 locale 渲染）。**`GET /state` 总是带本次连接的尾部**；只有
   * status 是 `connecting` / `fingerprint-pending` / `error` 时非空——也就是屏幕上确实有连接窗口
   * 的时候；其余状态为 `[]`。**SSE 状态帧里恒为 `[]`**：实时明细走 `GET /events/logs`（v2.12）。
   * **每次连接开始时重置**（手动连接 / 重连 / 自动重连都会），因此这里只有本次连接的行，第一行是带
   * 次数与时间的边界行；最多 120 条，旧的先掉。失败会被写成多行：阶段与错误码、双语原因、每条建议、
   * 脱敏并 `headTail` 截断的技术细节（`remote-dsh-start-failed` 为远端日志尾部逐行）。
   */
  logs: ConnectLogEntry[]
  /**
   * 这条日志尾的游标：`attempt` = 第几次连接（边界行的 N），`logSeq` = 最新一行的 `seq`。
   * 「单调」指同一游标内：`logAttempt` 只增不改；`logSeq` 在同一次 attempt 内只增，换 attempt 时
   * 随该次连接从 1 重新计数（所以消费方必须把 `(logAttempt, logSeq)` 当一对用，不能只看 `logSeq`）。
   * 用来让 Client 把「已合并的行」与一次快照对齐、并在日志通道不可用时用
   * `logs` 的最大 `seq` 兜底。旧 Host 没有这两个字段：Client 按 `logs` 的最大 `seq` 推导游标，
   * `attempt` 记为 0，只在收到 `reset` 帧时更新（v2.12）。
   */
  logAttempt: number
  logSeq: number
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
  ignoredNames?: string[]      // 文件夹下载里被跳过的名字（Windows 元数据 / 快捷方式；其他平台为空）
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
   * 已连接主机的轻量探活。连续三次失败才会触发远端重挂（§5.6）；默认开启、30s。
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
  /**
   * `/state` 快照的单调 revision：每次 Host 发布（SSE 帧与每次 GET 读到的当前快照）都带同一个当前值，
   * 状态变化时自增。Client 只接受比屏幕上更新的帧，乱序 SSE 或迟到的 GET 响应不得把界面回退。
   * **连接日志的追加不改变 `rev`**（v2.12）：日志是只增的、按 `(attempt, seq)` 排序的数据，走
   * `GET /events/logs`，不是状态模型变化——否则每 150ms 一次的合帧都会让 Client 丢掉在途的 `/state`。
   * 旧 Host 没有该字段：Client 退回「后到即生效」。
   */
  rev: number
  /**
   * 本次发布的代际：Host 进程 / 插件每次启动都不同。`rev` 只在本代际内单调；Client 发现 `instance`
   * 变化时接受新帧并重置水位（Host 重启或插件重载后 `rev` 会从 0 重新计数）。
   * 旧 Host 没有该字段：Client 只按 `rev` 比较。
   */
  instance: string
  hostVersion: string | null    // 本机 DSH 版本
  targetVersion: string | null  // = 本机 DSH 版本
  hosts: HostView[]; settings: SettingsView
  activeHostId: string | null; firstRun: boolean  // hosts.length === 0
  /**
   * 本机是否有 DSH 凭据存储；`false` 时密码只能用于本次连接。与每个 `HostView` 上的同名字段一致，
   * 新增主机（还没有 HostView）时由向导读这里决定是否显示「记住密码」。
   */
  passwordStorageAvailable: boolean
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
**唯一带连接日志尾的权威快照**（`hosts[].logs` + `logAttempt` / `logSeq`）。三种用途：首屏（页面在任何
SSE 建立前就能画出连接窗口）、轮询兜底（状态流断开时每 3s 一次）、**日志降级源**（日志通道不可用或 404 时，
缺失的行从这里补；见 §「状态通道与日志通道的对齐、去重与重连」）。

### `GET /events`（SSE，状态通道；DSH 准入 + Origin/Host 栅栏）
`text/event-stream`：连接后立即推一帧 `state`，随后**状态模型变化**时推送，每 15s 一次 `ping`。EventSource 无法设置自定义请求头，因此该路由先过 DSH 准入（Host/Origin 栅栏 + 浏览器会话），再过本插件的 Origin / Host 同源 / 非 cross-site 栅栏；没有会话的调用方在开流前就被拒绝（401），DNS rebinding 的调用方因 `Host` 不是本机 origin 被拒绝（403）。

这条流只承载状态：帧就是 `StateView` 本身，**唯一差异是 `hosts[].logs` 恒为 `[]`**（其余字段，含
`logAttempt` / `logSeq` 游标，与 `GET /state` 逐字相同）。连接日志走 `GET /events/logs`（见下一节）；
`phase` / `progress` 等进度字段**仍在这条流上**——它们是 `HostView` 的权威字段（v2.12，决策 B2）。
状态帧不带 `id:`：每帧都是完整快照，重连不需要续传。
```text
event: state
data: { ...StateView, hosts: [{ ...HostView, logs: [] }] }

event: download
data: { ...DownloadJobView }

event: remote-unreachable
data: { "hostId": "h_x", "phase": "suspected" | "confirmed" | "recovered",
       "source": "proxy" | "tunnel" | "heartbeat", "failures": 2, "at": "…" }

event: ping
data: {}
```

`download` 只在下载任务启动、进度变化、完成或失败时推送；客户端仍应在收到 `POST /downloads` 后轮询 `/status` 一次，避免 EventSource 尚未订阅时漏帧。
`remote-unreachable` 只在远端自重启的**一次**事件里推送最多三帧：`suspected`（第一次失败 / 代理故障，尚在确认）、`confirmed`（连续三次探活失败，开始重挂）、`recovered`（探活恢复）。若故障来源是代理/隧道，同一个 recovered 之前会先问本地监听器：能应答就不动；不应答才重建 listener（先建新、再关旧，失败按 30s→120s 退避）。重建会把 `RemoteView.viewRev` 自增（本地回环端口变了），承载方据此重新 `GET /hosts/:id/open` 并导航；关闭旧 listener 会短暂断开现有 WebSocket 与下载，属预期。同一类疑似上报在 recovered 后 15s 内不重复开新事件。重挂过程本身通过 `state` 的 `restarting-remote` 进度表达，客户端不需要依赖该事件才能恢复。拿不到新 launch token 的远端（例如日志被 supervisor 重定向）不会被接管，而是以 `remote-unreachable` 结束并保留主机、配置与 SSH。

### `GET /events/logs`（SSE，连接日志通道；同一套准入与栅栏）
新增于 v2.12。`text/event-stream`：**一条流多路复用**所有「日志可见」的主机（`status` ∈ `connecting` /
`fingerprint-pending` / `error`，也就是屏幕上确实有连接窗口的那几台），帧用 `hostId` 区分；不按主机开流
（浏览器对同一 origin 的连接数有限，状态流已经占了一条）。准入与状态通道**完全相同**：先 DSH 准入，
再过本插件的 Origin / Host 同源 / 非 cross-site 栅栏；EventSource 加不了自定义头，所以这条路由也**不要求**
`x-dsh-remote-go`。每 15s 一次 `ping`。

```text
event: log
id: x8k-1k2j-1:h_a:2:17
data: { "hostId": "h_a", "instance": "x8k-1k2j-1", "attempt": 2, "seq": 17, "visible": true,
        "entries": [ { "seq": 16, "at": "2026-11-17T14:03:11.412Z", "level": "info",
                       "phase": "bootstrap", "message": "npx: added 12 packages" },
                     { "seq": 17, "at": "2026-11-17T14:03:11.902Z", "level": "debug",
                       "phase": "bootstrap", "message": "npx: http fetch GET 200 …" } ] }

event: log
id: x8k-1k2j-1:h_a:2:140
data: { "hostId": "h_a", "instance": "x8k-1k2j-1", "attempt": 2, "seq": 140, "reset": true,
        "visible": true, "entries": [ /* 尾部 ≤ 120 行，含 boundary 行 */ ] }

event: log-end
data: { "hostId": "h_a", "attempt": 2 }

event: ping
data: {}
```

- **首帧对齐**：连接建立后，对每台「日志可见」的主机立即发一帧 `reset: true`（尾部 ≤ 120 行）——客户端
  不需要知道自己错过了什么，直接用它重建，天然幂等。
- **`id:` 与续传**：`id` = `<instance>:<hostId>:<attempt>:<seq>`。EventSource 自动重连时会把它回传为
  `Last-Event-ID`；服务端逐主机判定（`id` 只能描述一台主机，其余主机照常收 `reset`）：

  | 条件 | 行为 |
  |---|---|
  | 没有 `Last-Event-ID`（首次连接） | `reset` 帧（尾部 ≤ 120 行） |
  | `cursor.instance !== StateView.instance` | `reset` 帧（代际换了，游标作废） |
  | `cursor.hostId !== hostId` | 该主机的 `reset` 帧 |
  | `cursor.attempt !== 当前 attempt` | `reset` 帧（新一次连接，`seq` 从 1 重新计数） |
  | `cursor.seq < 环里最旧一行的 seq - 1`（超出 200 行环窗） | `reset` 帧 |
  | 否则 | 增量帧：只带 `seq > cursor.seq` 的行；**无新增则不发帧**（不制造空帧） |

- **离开可见集合**：主机状态变为 `connected` / `disconnected` 等时，先发最后一帧（`visible: false`），再发
  `log-end`；客户端之后不再收到这台主机的帧。`log-end` 不是清 UI 的依据——状态帧里的 `status` 已经是。
- **上限与背压**（与状态通道**各自的集合**，互不影响）：

  | 量 | 值 | 作用 |
  |---|---|---|
  | 活日志流 | 8（`MAX_SSE_LOG_CLIENTS`），第 9 条挤掉最老的一条 | 一个页面现在开 2 条流，共享计数会让 4 个标签页互相挤掉状态流 |
  | 单帧字节 | 64 KiB（`MAX_LOG_FRAME_BYTES`） | 超限的帧被切分；不会撞 1 MiB 的总闸 |
  | 单帧行数 | 120（`MAX_LOG_FRAME_ENTRIES`） | 一次写入几百行时拆成多帧，按 `seq` 升序 |
  | 合帧窗口 | 150ms | 每台主机的行在 hub 里合并后再发，不按行发 |
  | 单订阅者积压 | 1 MiB | 超限即断开该订阅者（**日志帧不重传**：重连后拿 `reset` 重建） |
  | 进程内最坏积压 | 8 × 1 MiB（状态）+ 8 × 1 MiB（日志）= 16 MiB | 与 v2.11 的 8 MiB 同量级 |

- **不做**：跨主机游标（一个 `id` 只描述一台主机）、服务端为每个订阅者保存无限积压（只从 200 行环里重放，
  超出即 `reset`）、按页面收窄订阅（所有页面看同一份状态）。日志行**在写入环时就已脱敏**，帧里不含
  token / 密码 / 私钥。

### 状态通道与日志通道的对齐、去重与重连

```text
client                          Host
  ├─ GET /state ───────────────►  rev=41, hosts[h_a].logs=tail(17), logAttempt=2, logSeq=17
  ├─ EventSource /events ──────►  立即一帧 state（rev=41，logs=[]）
  ├─ EventSource /events/logs ─►  对每台日志可见主机一帧 log（h_a，attempt=2，seq=17，reset，≤120 行）
  │                              之后每 15s 一次 ping
  └─ 日志通道断/404 ───────────►  状态流的 3s 轮询把缺失的行补回来（logs + logSeq）
```

客户端的三条规则（**服务端仍是唯一权威**，客户端只做合并，不造数据）：

- **R1（状态帧不覆盖日志）**：状态帧里的 `hosts[].logs` 恒为 `[]`，到达时保留已经合并的行；该主机的
  `status` 离开日志可见集合时清空。旧 Host 的帧里若仍带 `logs`（非空），以帧为准并重锚游标。
- **R2（快照补日志）**：`GET /state` 的日志尾**无条件**按 `seq` 合并进状态树——即使这份快照因为 `rev`
  太旧而不会重绘状态。日志是只增的、按 `(attempt, seq)` 过滤，用旧快照合并是幂等的；这条就是日志通道
  不可用时的降级路径。
- **R3（日志帧按游标合并）**：`frame.instance` 与当前代际不同 ⇒ 清空该主机的行并作废游标（随后必有
  `reset`）；`attempt` 更大 ⇒ 按 `reset` 处理；`attempt` 更小 ⇒ 整帧丢弃；`attempt` 相同 ⇒ 只接受
  `entry.seq > cursor.seq` 的行，全部更旧则整帧丢弃。`reset: true` ⇒ 用 `entries` 替换该主机的数组。

**幂等承诺**：客户端逐条按 `seq` 过滤，服务端因此可以自由重发（重连、`reset` 与快照叠加），不会出现一行
渲染两次；这也是本协议不需要 ACK / 应用层重传的理由。`reset` 的内存上界是一帧（≤ 120 行）。

**降级（v2.12 双向容忍）**：`/events/logs` 返回 404（旧 Host）或一直连不上时，日志流自动关闭、**不报错、
不弹窗、不轮询**；连接窗口的日志继续由 `GET /state` 的轮询（R2）提供，最坏延迟一个轮询周期（3s）。
反过来，旧 Client 对新 Host 只会看到空的 `logs`（连接窗口日志为空），其余功能正常。

### `GET /version`
```json
{ "ok": true, "version": "0.2.0", "apiVersion": "2.12", "hostVersion": "0.2.2-rc.1" }
```

### `GET /diagnostics/self`
返回插件入口与 client-module 图行，用于验收/排障（`home` / `stateDir` 等机器路径与用户名同样过脱敏，
`storeCorrupt` 表示 `hosts.json` 被隔离过）：
```json
{ "ok": true, "plugin": { "id": "dsh-remote-go", "version": "0.2.0" }, "at": "…",
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
不合法的 id 会被替换成一个新的 id，不会被采纳（`id` 同时是代理路由与凭据记录键的一部分，不能让调用方
伪造或占用别人的条目）。认证只有私钥文件或密码；`auth.type="key"` 省略 `keyPath` 时用
`SettingsView.defaultKeyPath` 补齐；密码不经此接口传输（用 `POST /hosts/:id/password` 或 `connect` 的请求体）。
把已保存密码的主机改成密钥认证时，Host 会删除该主机的密码记录；`DELETE /hosts/:id` 同理。
`keepAlive` / `idleMinutes` / `autoReconnect` / `hostKeyPolicy` 也随主机条目一起保存（不再有单独的 keepalive 端点）。
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
异步发起连接：立即返回 `{ "ok": true, "accepted": true }`；已在连接 / 已连接 / 正在重启远端时返回 `{ "ok": true, "accepted": false, "reason": "already-connecting" | "already-connected" | "already-restarting" }`。进度经 `/events` 推送。

`rememberPassword` 默认 **true**：请求里携带的密码在 SSH 认证通过后写入 DSH 凭据存储（主机删除、切回密钥认证或
`rememberPassword: false` 时删除），之后包括后台重连和 Host 重启后的首次连接都直接使用，不再询问；成功、失败都
不会把密码回传给 Client（`passwordSaved` 只表示是否已保存）。为 `false` 时密码只用于本次连接，并清除此前保存的记录。
不携带密码时不改动已有记录（已保存的密码会由 Host 读取使用）。
```json
{ "password": "默认保存到 DSH 凭据存储", "rememberPassword": true }
```

### `POST /hosts/:id/password`
只记住或清除这台主机的 SSH 密码，不发起连接（向导的「保存」用它，因此不连接也不会丢掉刚输入的密码）。
请求二选一：`{ "password": "..." }` 记住；`{ "clear": true }` 忘记。响应
`{ "ok": true, "available": true, "saved": true }`；`available: false` 表示本机没有凭据存储、什么也不会保存
（此时 `saved` 必为 false）。空密码返回 400 `invalid-input`（字段 `password`）。密码本身不写 `hosts.json`，
也永不出现在响应、状态帧或诊断里。

### `POST /hosts/:id/disconnect`
请求 `{ "stopRemote": false }`；`stopRemote=true` 或该主机策略为 `stop` 时同时停止远端 web。响应 `{ "ok": true }`。
这是「断开连接」的收尾路径：按存活策略处理（`keep` 只关隧道、`idle` 保留 SSH 稍后停、`stop` 停远端），
停止远端时直接使用当前记录的 pid，**不做归属校验**。显式、可审计地「关掉这台远端 DSH」请用下面的
`stop-remote`。

### `POST /hosts/:id/stop-remote`
关闭本连接管理的远端 DSH（管理界面卡片上的「关闭」），无请求体，同步执行：

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
  卡片按钮并显示「正在关闭远端 DSH…」进度；结束后状态帧直接是 `disconnected`。
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
  - 必须在**本机用户主目录之下**；`Startup` / `autostart` / `systemd`、`Start Menu\Programs`、
    macOS 的 `Library/LaunchAgents` / `Library/LaunchDaemons` / `Library/StartupItems` 等自启动位置、
    `.ssh` / `.gnupg` 等凭据目录、`.bashrc` / `.profile` / `.zshrc` / `.xsessionrc` / `.config` / `.local`
    等登录脚本与配置目录、系统目录与 `shell:` 形式的路径一律拒绝（`invalid-input` + 字段 `destination`）。原因见
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

**进度与阶段仍随状态通道（`GET /events` 的 `state` 帧与 `GET /state`）下发；日志通道不承载进度**
（v2.12，决策 B2：`phase` / `progress` 是 `HostView` 的权威字段，搬走会出现两份来源）。

- `ssh-connecting`（`host`，跳板机另有 `jump` / `via`）、`host-key-confirm`（`sha256` / `keyType`；跳板机的确认额外带
  `role: "jump"` 与跳板机地址 `host`，这是「等待确认的是哪台机器」的唯一信号——目标机的帧形状不变）
- `auth-checking`、`probing`
- `remote-dsh-running`（`count`）、`downloading-node`（`version` / `mb`）、`installing-node`（`version`）、`bootstrapping`（`level`，恒为 `npx`）
- `bootstrap-first-run`（`version`）、`bootstrap-fetching`、`bootstrap-installed`、`bootstrap-progress`（`detail`）
- `starting-remote`（`level`）、`tunneling`、`verifying`、`ready`、`reconnecting`（`attempt` / `max`）
- `reconnect-waiting`（`attempt` / `retryInSec`）：自动重连的慢速阶段（快速预算用尽后每约 30s 一次，最长 10 分钟），
  文案是「链路仍未恢复，{retryInSec} 秒后继续重试」，不显示次数分母
- `restarting-remote`（`reason`，可选 `pid` / `port` / `level`）：本地重启远端或远端自重启后的重挂；状态保持
  `connecting`，阶段只走 `start` → `tunnel` → `verifying`
- `stopping-remote`（可选 `pid` / `port`）：显式关闭远端 DSH；状态保持 `connecting`，只走 `start` 阶段，
  结束后直接是 `disconnected`，不会进入 `tunnel` / `verifying`

## 3. 安全约束（客户端必须遵守）

1. 密码只在 `connect` / `password` 请求体里出现，不写入客户端存储，不放到 URL；Host 默认在 SSH 认证通过后写入
   DSH 凭据存储（不写 `hosts.json`），`rememberPassword: false` 时删除已有记录。
2. `token` / 带 token 的 URL 只在内存中传递；`GET /open` 的 `url` 只交给桌面端 guest，`webUrl` 只交给同源 iframe。
   两者都只用于首次导航，客户端不得持久化、不得拼进其它请求。
3. `saveTokens` 默认 false；为 true 时由 Host 在 `$DSH_HOME` 下以 0600 保存，客户端不接触。
4. 所有 `fetch` 使用 `credentials: 'same-origin'` 并带 `x-dsh-remote-go: 1`。
5. guest 只允许 `http://127.0.0.1:<port>`；浏览器 iframe 只允许 `/dsh-remote-go/remote/<hostId>/` 形状的
   同源路径（拒绝绝对 URL、`//`、转义与路径穿越），两端都在交给承载器前再校验一次。
6. 每条请求先过本机 DSH 的准入（Host/Origin 栅栏 + 浏览器会话）；内核没有 Connection 服务时退回本插件自己的栅栏。
7. `Host` 必须是本机监听 origin：DNS rebinding 下浏览器会带上攻击者的域名，这是唯一能拦下它的检查（`/events`
   与 `/events/logs` 也只有这一道）。
8. 跨站请求（Origin 不同或 `sec-fetch-site: cross-site`）必须被拒绝；同源代理使用同一栅栏。
9. 代理只服务 `connected` 主机：断开后同一 URL 立即不再有上游；远端的 cookie 只存在 Host 内存里。
10. **日志通道与状态通道共用同一套准入与 Origin/Host 栅栏**（v2.12）；日志帧里只含**已脱敏**的行：
    脱敏发生在写入日志环时（`appendConnectLog`），`ConnectLogEntry` 不含 token、密码、私钥或 home 路径，
    与 `GET /state` / 诊断导出读的是同一份数据。
