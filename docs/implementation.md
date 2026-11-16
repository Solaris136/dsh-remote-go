# dsh-remote-go 实现
> 面向维护者：模块划分、连接管线、数据与测试。产品设计见 [design.md](design.md)，协议见 [api.md](api.md)。本文只引用**符号名**，不引用行号。

## 1. 仓库结构
```text
dsh-remote-go
├─ index.js                 包入口：再导出 src/index.js
├─ client.js                浏览器半端（单文件、无构建、window.__ModuleLoader__ 注册）
├─ cordis.patch.yml         bundle 的 profile patch
├─ vendor/                  ssh2 与 js-yaml 的单文件 bundle（运行时零依赖）
├─ package.json             dsh.bundle.patch + dsh.client（web / immediately / inject）
├─ src/
│  ├─ index.js              Host 插件入口：挂 API 与同源远端代理、注册模型工具、初始化 service、探测本机版本
│  ├─ tools.js              模型工具：只读的 remote_hosts_list（白名单投影，无写操作面）
│  ├─ admission.js          DSH 准入装配：把 `ctx.get('connection').requestRejection` 变成每请求闸门
│  ├─ api.js                本地 HTTP + SSE 路由（契约实现）
│  ├─ request-trust.js      本地 API 与同源代理共用的 Host/Origin 栅栏（单一实现）
│  ├─ remote-proxy.js       浏览器半端的同源远端代理（前缀 HTTP + 每主机 WebSocket + cookie jar）
│  ├─ service.js            公共 facade：装配 ctx（依赖 + 可变状态）并委托给下面 6 个协作者
│  ├─ connect-pipeline.js   连接管线：目标解析 → transport → probe → 托管 Node → 启动/收养 → 隧道 → 校验；本地重启与远端重挂也在这里
│  ├─ host-registry.js      主机 CRUD、设置、快照、key-file 浏览与 ssh 别名发现
│  ├─ host-lifecycle.js     重连/空闲计时器、轻量心跳与「连续两次失败」确认、一次性动作令牌、唯一 teardown 路径、shutdown
│  ├─ connect-progress.js   日志环、/state 合并、进度码与 npx 行解析
│  ├─ prompts.js            指纹确认与远端冲突的用户决定 rendezvous
│  ├─ host-runtime.js       每主机 runtime 对象的唯一形状（建/用分开）
│  ├─ host-view.js          每主机对客户端的只读视图（HostView 投影）
│  ├─ connect-log.js        连接日志：每次连接的重置与边界行、失败分解、环形缓冲下限、日志尾与可见状态
│  ├─ diagnostics.js        10 项诊断检查表（只读投影，不新建连接）
│  ├─ ssh.js                ssh2 封装：指纹策略、认证回退、exec、forwardOut
│  ├─ ssh-config.js         ~/.ssh/config 解析与别名发现
│  ├─ known-hosts.js        known_hosts 只读解析 + OpenSSH SHA256 指纹
│  ├─ local-ssh.js          读取本机 ~/.ssh 材料（只读）
│  ├─ probe.js              远端环境探测（单条 POSIX sh，key<TAB>value）
│  ├─ bootstrap.js          npx 预检：环境判定、固定命令模板、版本回读
│  ├─ node-runtime.js       托管 Node：engines.node 下限解析、下载校验、安装/复用
│  ├─ webapp.js             远端 web 生命周期的公开再导出面（remote-web / remote-proc）
│  ├─ remote-web.js         远端 dsh web 启动/停止/收养、启动脚本与 URL 解析、重挂时的状态重读与 run registry 重写
│  ├─ remote-proc.js        进程扫描、foreign DSH、探活与 token 交换、监听端口与端口归属 pid
│  ├─ remote-path.js        远端绝对路径校验/命名、本地文件名清洗
│  ├─ remote-files.js       远端路径校验、单文件/文件夹下载入口
│  ├─ local-download.js     本机落盘：唯一文件/目录、流式写入、重名自动改名
│  ├─ download-jobs.js      Host 侧下载任务：准备、进度节流、TTL/取消/容量上限
│  ├─ tunnel.js             本地回环 TCP ↔ SSH forwardOut
│  ├─ store.js              hosts/settings/secrets 持久化与内存缓存
│  ├─ atomic-json.js        原子 JSON 写（tmp + wx + fsync + rename 重试）
│  ├─ settings.js           设置与主机条目的默认值/校验/清洗
│  ├─ secrets.js            DSH 凭据存储适配（密码不落 hosts.json）
│  ├─ layout.js             远端目录布局（~/.dsh 与插件状态目录）
│  ├─ version.js            版本解析/比较/Node 门槛
│  ├─ local-version.js      本机 DSH 版本探测（env → clientModules → package.json）
│  ├─ errors.js             分类错误（中英双语、下一步、技术细节）
│  ├─ redact.js             诊断脱敏
│  ├─ key-files.js          用户主目录内的私钥文件浏览
│  ├─ constants.js          默认值/常量
│  └─ util.js               通用工具（时间、延迟、日志级别、文本）
├─ locale/{zh,en}.json      插件市场显示元数据
├─ test/unit/               node:test 单元测试
├─ test/integration/        模拟远端集成 + 浏览器/桌面验收
├─ test/helpers/            共享测试工具（source-scan 等）
├─ e2e/sim/                 本机模拟远端主机（真实 SSH + HTTP stub）
├─ e2e/remote/              真实主机验收说明（无自举脚本）
└─ scripts/                 仓库规范 / 市场条目 / 打包 / 语法检查
```
依赖方向单向：`index → service`；`service` 建好 `ctx` 后委托 `host-registry` / `connect-pipeline` / `host-lifecycle` / `connect-progress` / `prompts`。`connect-pipeline → host-lifecycle / prompts / connect-progress`，`host-lifecycle` 不依赖 pipeline（重连由 pipeline 发起），`prompts`/`connect-progress` 是叶子；低层模块不反向依赖 `service`，`api.js` 只依赖 `service` 的公开方法与 `errors`/`util`（Host/Origin 栅栏与同源代理共用 `request-trust.js`，不复制实现）。`host-runtime.js` 是 runtime 形状的唯一来源，`host-view.js` 是 `HostView` 的唯一投影，日志尾长度与可见状态由 `connect-log.js` 决定；三者都不做 I/O，新增字段或视图只改一处。

## 2. Host 入口与装配
`src/index.js#apply(ctx, config)`：解析 `$DSH_HOME` 与插件状态目录 → `HostStore` → `SecretStore`（没有 `credentials` 服务时降级为仅内存）→ `RemoteGoService`（注入 store/home/logger/secrets/本地版本/指纹确认超时）→ 组装准入函数 `admit` → `createApi({ service, getOrigin, admit, logger, diagnostics })` 在 `ctx.effect` 内挂到 `webServer` 的 `/dsh-remote-go/api` 前缀 → `createRemoteProxy({ webServer, getOrigin, admit, resolveHost: service.webViewTarget })` 挂到 `/dsh-remote-go/remote/` 前缀，并在 service 的每次 `state` 上 `proxy.sync(service.hostIds())`（保持每主机一条升级路由）→ 异步 `service.init()` + `detectLocalVersion`/`detectLocalEnginesNode`（读不到版本记 warn）→ 卸载时 `api.dispose()`、`proxy.dispose()`、`service.shutdown()`、注销两条路由。

`admit = createAdmission(ctx, logger)`（`admission.js`）是**两条路由唯一的准入入口**：`ctx.get('connection')?.requestRejection(req)`，返回内核的拒绝状态（401 浏览器会话未认证/失效，403 Host 或 Origin 不通过）或 `undefined` 表示放行。三条约束固定在这里，不在 `api.js`/`remote-proxy.js` 里各写一份：

- **`connection` 是 optional，且必须用 `ctx.get` 读**。Cordis 对插件 fiber 未 inject 的服务直接 `ctx.connection` 会抛错（`cannot get property "connection" without inject`），旧内核也可能没有这个服务；`ctx.get('connection')` 与 `SecretStore` 读 `credentials` 走同一条路径。服务缺失时 `admit` 返回 `undefined`，API 回落到 `x-dsh-remote-go` 标识头 + 同源栅栏，代理回落到 Host/Origin 栅栏——插件在旧内核上仍可用，不会因为准入不可用而全站 403。
- **服务存在时每条请求先过准入，再进路由分发**。HTTP 侧拒绝时直接回该状态 + `{ ok:false, error:ErrorView }`；升级侧拒绝时回 `HTTP/1.1 <code>` 后关闭 socket（升级错误只能写在 socket 上）。
- **准入抛错按拒绝处理**（回 500 + `internal`，不落到 `invalid-input`），绝不因为检查本身失败而放行；`ctx.get` 本身抛错则只记 warn 并按「服务缺失」降级（那次读取无法判断请求本身）。三条分支由 `admit` 的单测覆盖。

`/health` 是唯一豁免：它是契约里的存活探针、不返回状态数据，因此不要求浏览器会话，但仍过 Host/Origin 栅栏（见 [api.md](api.md)）。`optional = ['connection','credentials']` 只声明可选依赖，不是访问凭据；其余依赖都是 node 内置模块或本仓库模块，发布包 `dependencies: {}`。

模型工具在同一条 `ctx.effect` 里装配：`registerHostTools(ctx, { service, logger })`（`tools.js`）→ `tools.register(listTool(...))` 注册只读的 `remote_hosts_list`，effect 的清理函数调用 `register` 返回的 disposer，所以卸载后工具真的消失。**`tools` 不进 `inject`**：它是可选服务，用 `ctx.get('tools')` 取（与 `connection` / `credentials` 同一条路径）；取不到时只记一条 info 并跳过注册——缺 `tools` 的宿主不会因此把整个插件停在 state 0（那会连主机条与 HTTP API 一起不可用），主机条必须还能用。服务晚到时 `ctx.inject(['tools'], …)` 会 park 一个子 fiber，等它就绪再注册；定义被内核拒绝也只记一条 warn。工具**没有写操作面**：没有 add / update / remove / connect，也就没有 confirm 门、没有 jobs、没有 `exec.agent.session.id`，维护主机仍走管理界面。它只注册在 Host 半端，`package.json` 的 `dsh.client` 与远端都没变。

## 3. 连接管线
入口 `RemoteGoService#connect(id)` 只登记参数（密码、是否保存），交给 `connect-pipeline.js#startConnect`，把 `runtime.connectPromise` 设为 `connectPipeline(ctx, runtime)` 后立即返回；进度全走 `state` 事件。顺序：

```text
1. 清空上次 error/warning/facts/exchange，status = connecting
2. resolveTarget：本机 ssh 材料 → 别名解析 → known_hosts 指纹集合；已保存过密码则从 SecretStore 取回（后台重连无需弹窗）
3. openTransport：直接 sshFactory(buildOptions) → connect → captureFingerprint；跳板机先连跳板再 forwardOut(target 22)，通道上建第二条 ssh；onHostKey 进入 prompts.requestHostKey（strict 直接拒绝，否则挂起等 UI）
4. probeRemote：OS/Node/npm/npx/curl/磁盘/凭据/SSH 会话标记 → runtime.facts；ensureRemoteNode 按 engines.node 下限装/复用 ~/.dsh/remote-go/node/v<version>（失败即中止），applyManagedNodeFacts 写回 node/npm/npx 路径
5. 本机版本未知则失败；planNpx 产出固定模板并绑定托管 Node 的 PATH
6. adopt：读 run registry（dshHome/profile/pid/日志 URL/HTTP 探活），版本不符的本插件实例先 stop 再另起；未收养才继续：清掉不可收养的残留实例 → resolveForeignConflict 扫描外来 DSH（stop/alongside/cancel）
7. npx 预检（前台，无超时）：verifyNpxVersion 回读必须精确相等；startRemoteWeb：setsid nohup 启动，轮询 `dsh web:` 行取 pid/port/token
8. createTunnel：本地 127.0.0.1:0 → forwardOut(远端 port)
9. waitForRemoteUi（远端 curl）→ exchangeTokenOverTunnel（token→cookie→干净首页）
10. connected：记录 lastOpenedAt/activeHostId，按设置保存 token/密码，挂断线处理器（host-lifecycle.scheduleReconnect）
11. 失败：toErrorView，按 desired 判定「用户取消」/「连接失败」，统一 teardown
```

teardown（`host-lifecycle.js#teardownRuntime`）是唯一收尾路径：取消冲突提示与一次性动作令牌、停止心跳、置 `closing`、取消空闲计时器、按策略停远端、关隧道、释放 SSH、清空 probe/exchange/token/remote；`disconnect`、`removeHost`、连接失败与 `shutdown` 都复用它。

### 3.1 重启与重挂（同一份管线代码）
- `restartHost`：仅 `connected` / `remote-unreachable` 可用；用 runtime 里已记录的 facts 重算 plan，在**同一条 SSH** 上
  **先**走 `resolveForeignConflict`（用户取消时尚未停止任何东西），**再** `stopRemoteWeb` 经授权的 pid →
  `[start]` → `rememberLaunched` → `writeRunRegistry` → 关旧隧道、按新端口 `openTunnel` → `verifyRemoteUi` →
  `markConnected`。kill 授权由 `killAuthorized` 判定：registry 命名 + `runtime.launched`（只由 start 脚本结果 /
  `origin:"launch"` 的 adopt 写入）+ `/proc` starttime 一致 + cmdline/env 的 profile/home 一致，四者缺一不杀；
  `alongsidePids` 永不 kill。动作内创建的隧道由 `finally` 收尾（令牌失效则关闭并清 `remote.localPort`），
  `openTunnelFor` 在 ssh 已释放时直接抛错，不会把 null 传输交给监听器。取消冲突且未停过任何进程时
  `resumeConnected` 回到原连接。
- `reattachHost`：由 watchdog 的「连续两次探活失败」调用。`ctx.deps.resolveRemote`（`remote-web.js#resolveRemoteWeb`）
  只接受同时满足「端口属于该 pid」「cmdline 是同一 profile」「environ 的 DSH_HOME 是同一 home」「最新就绪行命中
  同一端口（有 launch token）」的候选；进程扫描路径只用于给出 `no-token` 解释，不产生接管；版本来自 npx pin 或
  被加载包的 `package.json`，证明不了就保持未知且不写进 registry。通过后 `writeRunRegistry(origin:"reattach")`、
  关旧隧道、按新端口重建、换 token、`verifyRemoteUi`、`markConnected`，并写 `runtime.restarts`（诊断导出）。
  重挂失败报 `remote-unreachable`，保留 SSH 与主机配置。
- `stopRemoteHost`：显式「关闭远端 DSH」，同步执行。状态机与 `restartHost` 相同（`connected` / `remote-unreachable`），
  其余与进行中的一次性动作一律抛 `stop-unavailable`（API 409）。授权是 `closeAuthorized`：pid 必须是
  `runtime.remote.pid`、不在 `alongsidePids`、本连接记录过（`runtime.launched` 或 `runtime.bound`）、
  `run/web.json` 仍命名它且 home/profile 一致、`/proc` starttime / cmdline / `DSH_HOME` 再证明一次；任一不满足
  就不 kill 并恢复原状态（`restoreStopState`，失败详情经 `logFailure` 写入连接日志）。pid 已消失时只调
  `clearRunRegistry`（新注入的 `ctx.deps.clearRegistry`，绝不按残留 pid 发信号）。成功路径复用
  `disconnectHost(..., {stopped:true})`：不再 arm 空闲停止、抑制 `keepAlive:"stop"` 的第二次 stop 信号、释放
  SSH，状态落 `disconnected`。
  `rememberBound` 在重挂（`runReattach`）与收养 reattach 记录时写入 `runtime.bound`（pid + starttime + origin），
  它给关闭动作提供身份证明，但**不**写进 `runtime.launched`，所以重启仍然只杀自己启动的进程。
- 两个动作都持有一个**令牌**（`beginLinkWork` / `isLinkWorkCurrent` / `endLinkWork`）：disconnect、SSH `close`
  或新的连接会 `cancelLinkWork`，迟到的旧动作只会打一行 debug 日志，不能写状态。`markConnected` 每次
  `remote.viewRev + 1` 并重启心跳。
- 心跳的代理/隧道疑似事件有 15s 冷却。恢复阶段先 `tunnelProbe`（`tunnel.js#probeLoopback`，直接请求
  `127.0.0.1:<localPort>`，任何 HTTP 状态都算通）；本地 listener 仍应答就不重建，否则 `repairTunnel`
  重建（同一远端端口、token 不变）：持 link-work 令牌、**先建新 listener 再关旧**、`finally` 在令牌失效时关闭
  自己创建的 listener 并清 `tunnel`/`localPort`；成功后 `viewRev + 1`（桌面载体据此重新取 `open` 并导航，旧
  listener 的 WS/下载会短暂断开），失败保留旧 listener 并按 30s→120s 退避。`teardownRuntime` /
  `shutdownAll` 先 `cancelLinkWork` 再 **await** `runtime.tunnelRepair`，所以 disconnect / removeHost /
  shutdown 不会在 teardown 之后才发布 listener。
- 重挂后点重启：监听者是启动脚本包装进程 spawn 的 DSH 子进程，`launched` 里通常没有它；`runRestart` 会把这个
  「已知、存活、非 alongside」的 pid 合并进 `resolveForeignConflict`（即使 registry pid 原本在扫描 ignore 列表），
  用户选 `stop` / `alongside` 后才 `[start]`，`cancel` 保留原连接；选择 `stop` 记 `stoppedOwn=true`，失败不会
  “恢复”已停掉的实例（N3）。该合并发生在扫描失败分支之前：`findForeign` 失败但 knownProcess 存在时仍会弹冲突，
  只有扫描失败且无已知实例时才继续。`stopWeb` 未确认停止（`ok:false`）时不启动第二个实例，保留原连接、写
  `HostView.warning`，用户可重试或先断开。`await stopWeb` 之后重新检查动作令牌，`resumeConnected` 还要求
  `desired=connected` + SSH 在线 + 隧道非空；disconnect / removeHost 同窗口时迟到的动作只返回，不写状态、不起
  心跳。成功挂载会清掉 `restart-stop` 来源的 warning，`alongside` 提示保留。

## 4. SSH、指纹与运行时
`ssh.js` 封装 ssh2：`hostVerifier` 计算 `SHA256:<base64>`，按 `pinnedFingerprint` → `knownHostFingerprints` → `hostKeyPolicy` 决策；认证回退只有私钥文件 →（密码认证时）密码，不支持 Agent；`exec(command,{timeoutMs,stdin})` 统一返回 `{ code, stdout, stderr }`，`forwardOut` 供隧道与跳板机。`onHostKey` 由 service 提供：`strict` 直接抛 `host-key-unknown`，否则把指纹挂到 runtime 并返回 promise，`confirmFingerprint()` 或 120s 超时后 resolve。

- 本机版本：`local-version.js#detectLocalVersion` 依次 `DSH_VERSION`/`DSH_RUNTIME_VERSION`、`clientModules.graph().release.version`、`@deepseek-ai/dsh/package.json`；目标版本恒等于本机版本。
- `bootstrap.js#planNpx` 只产出 `npx -y @deepseek-ai/dsh@<version>` 固定模板，`verifyNpxVersion` 回读不等即 `version-mismatch`。
- 托管 Node 版本取本机 DSH `engines.node` 下限（`node-runtime.js` 负责下载、SHA-256 校验、解压与复用）；`remote-web.js` 持有全部远端 shell 命令模板：启动脚本写 `logs/web.log` 并读 `dsh web:` 行，`run/web.json` 只记录 pid/port/version/profile/dshHome/launch 标记（无 token）。

## 5. 本地 HTTP API 与同源远端代理
`api.js`：`webServer.register({ kind:'prefix', path:API_PREFIX, handler })`；每条请求先过 `admit`（§2，`/health` 除外），再按路由走 `authorize()`（`x-dsh-remote-go: 1` + Host 自检 + Origin 同源 + 拒绝 cross-site）或 `/events` 的 `authorizeOrigin()`（EventSource 不能加头，Host 自检与同源栅栏照旧）；`/health` 免会话、但同样过 Host/Origin 栅栏。Host 自检就是 `request-trust.js#sameServerHost`（与代理侧同一份实现）：Host 必须指向本机监听 origin，loopback 拼写互换，省略默认端口按协议折算——DNS rebinding 下攻击页的 `Host` 是攻击者域名，这一条是唯一能拦下它的检查，`/events` 只有这一道。解析器需要改写的 authority 一律拒绝（`user@host`、反斜杠、`#`/`?`、尾点 `127.0.0.1.`、补零端口 `:057442` 等），因为浏览器只会送出序列化后的 authority，而按改写结果比对会把 `attacker.example@127.0.0.1:port` 当成回环。`getOrigin()` 在监听尚未绑定（或内核没有该方法）时返回 null，此时 Host 自检跳过、保留旧行为：受支持的 `engines.dsh` 范围都提供 `webServer.getOrigin`，这一边界只为不让内核差异把插件变成全 403。请求体上限 1 MiB；错误统一 `{ ok:false, error:ErrorView }`，`invalid-input`→400、其余业务错误→409、未知异常→500；SSE 在 `service.on('state')`、`service.on('download')` 与 `service.on('remote-unreachable')` 上广播，连接先推一帧、15s 一次 `ping`。重启 / 关闭两个一次性动作的路由同样挂在同一 dispatcher 之后，自动继承 `admit`，不单独放行。路由与字段见 [api.md](api.md)；`/diagnostics/self` 额外返回 Host 入口、`engines.node` 与 client-module 图行，用于验收/排障。下载任务由 `download-jobs.js` 管理：`POST /downloads` 启动、`/status` 轮询、`DELETE` 取消；Host 用同一条 SSH/SFTP 连接把文件或文件夹**流式写入用户选择的本地目录**，不返回二进制字节、不打包 ZIP、不在远端落盘（取消会清理由本次任务创建的文件/目录）。

`remote-proxy.js` 是浏览器半端的远端界面承载面（契约「远端界面同源代理」）：`parseViewPath` 把
`/dsh-remote-go/remote/<hostId>/<rest>` 拆成主机与上游路径；`handle` 与 `handleUpgrade` 都先过 `admit`
（代理后面是一台已连接主机的**远端会话 cookie**，只有通过 DSH 准入的调用方才能用它），再过
`request-trust.js#trustedRequest` 的同源栅栏（Host/Origin 同源、非 cross-site）；请求经 `upstreamHeaders`
去掉逐跳字段、把 `Host`/`Origin` 改写为该主机的
回环 authority、并用 per-host jar 注入远端 cookie；响应经 `storeCookies` 收走 `Set-Cookie`、`responseHeaders`
去掉逐跳字段与 `X-Frame-Options`、只从 CSP 移除 `frame-ancestors`（`withoutFrameAncestors`）、把指回远端的
`Location` 折回前缀。WebSocket 只处理远端唯一的路由
`/api/remote.mux`：`sync(hostIds)` 为每台配置主机注册一条精确升级路由，升级握手保留 `Connection`/`Upgrade`
并注入 jar cookie。`resolveHost` 由 `service.webViewTarget(id)` 提供，只对 `connected` 且有隧道的 runtime 返回
`{ localPort, remotePort }`；因此断开即失配、无需额外清理。代理在 `dispose()` 时注销全部升级路由、销毁升级
socket 并清空 jar。

### `ctx.connection.fetch.register` 的评估结论：不接

issue 给的另一条路是「精确路由改挂 `ctx.connection.fetch.register`」。核对运行中内核（0.2.2-rc.3）的类型声明
与实现后，结论是**不接，准入统一走 `requestRejection`**：

- `fetch.register` 是 **exact Fetch-route registry**（`HostConnectionFetch#register`）：路由形状是
  `{ path, methods, requestBody, fetch(Request) => Response }`，`path` 是共享 `/api` 通道下的**精确路径**。
  它没有前缀匹配，表达不了 `/dsh-remote-go/remote/<hostId>/<rest>` 这种「任意方法 + 任意子路径 + 二进制 /
  SSE 原样转发」的前缀转发。
- 它不接管 HTTP 升级。远端唯一的 WebSocket 是 `/api/remote.mux`，需要「每台已连接主机一条精确升级路由 +
  自定义握手改写」，只能用 `webServer.registerUpgrade`；`fetch: Request => Response` 契约里没有升级 socket。
- 迁过去的代价是把整个传输层塞进一个更窄的接口：cookie jar、逐跳字段过滤、`Host`/`Origin` 改写、CSP
  `frame-ancestors` 移除、`Location` 折回、流式响应都依赖直接操作 `req`/`res` 与原始 socket，同一个请求 /
  响应转换会被迫重写一遍，回归风险远大于收益。
- 内核为「另一条 Web 路由」准备的入口本来就是 `requestRejection`（JSDoc：*Apply Connection's Host/Origin
  checks and browser authentication to another Web route*），语义一致且不用搬传输层。因此本仓库用 `admit`
  统一准入，路由继续挂 `webServer.register` / `registerUpgrade`。

## 6. 持久化
本地 `$DSH_HOME/remote-go/`：

| 文件 | 内容 | 权限 |
|---|---|---|
| `hosts.json` | 主机清单（地址、认证、跳板机、存活策略、指纹 pin、时间戳） | 0600 |
| `settings.json` | 设置（见契约 SettingsView） | 0600 |
| `secrets.json` | 仅 `saveTokens=true` 时保存的 launch token | 0600 |

全部走 `atomic-json.js`：目录 0700、文件 0600、临时文件 `wx`、fsync、rename 重试、失败清理临时文件。密码不进 `hosts.json`，保存时写 DSH 凭据存储。远端 `~/.dsh/remote-go/`：`logs/web.log`、`run/web.json`、`node/`、`downloads/`；远端 DSH 自己的数据始终在 `~/.dsh`，本插件不写它的插件、配置或凭据。

## 7. Client 半端
`client.js` 是**单文件、无构建**的浏览器插件：`window.__ModuleLoader__.load({ id, factory(require) })`，只 `require('react')`。

- 注册：只注册 `shell.overlay`（唯一浮层宿主：管理清单 / 向导 / 提示 / 下载卡）与主机条；不注册 `settings.section`、`main` 主面板或侧边栏任何行。主机条：`mountHostRow(win)` 是唯一实现——本地页面直接调用；远端由两个载体分别注入——桌面 guest 里跑 `HOST_ROW_SCRIPT = '(' + mountHostRow.toString() + ')(window)'`，浏览器 iframe 里直接 `mountHostRow(frame.contentWindow)`（同源，无需字符串求值）。每 1.5s（`SWITCHER_TICK_MS`）用 `updateSwitcher` 推状态，按 `[data-window-drag]` 找侧边栏，页面重渲染后行自动回位。
- 远端工具：`mountGuestTools` 在每次远端页面加载后与主机条一起注入，拦截远端文件树右键菜单的下载项，把 `{ action:'download-file', kind, path, name }` 交给同一条 intent 通道；目录菜单没有原生下载项，脚本克隆一个菜单项追加「下载到本地」。桌面 guest 走 `__drgBridgeQueue` 轮询，浏览器 iframe 直接调用 `__drgBridgeSink`。路由到本地后由 `toolStore` 交给浮层里的下载任务。下载卡是右下角的 `DownloadCenter`（可拖动 transform + 视口夹取），`DownloadProgress` 订阅 SSE `download` 帧并在 ready 后调用 `saveAs`；准备阶段提供取消按钮。终端完全交给 DSH 自带的开始页卡片 / `Ctrl+\``，插件不再注入终端脚本或注册 `sidebarRight`。
- 能力桥：`mountCapabilityBridge` 用同一条 intent 通道承载「只有顶层文档才能做」的三件事——`{ action:'open-external', url }`、`{ action:'clipboard-write', text, id }`、`{ action:'notify', tone, code?/text? }`。frame 内：捕获阶段拦 `a[href]`（只认解析后 origin 不同、绝对 http(s)、无凭据；`download` 属性与 `[data-drg-dir-download]` 项直接放行；`button !== 0` 或带 `ctrl/meta/shift/alt` 的点击早退，保留浏览器默认语义）、覆写 `window.open`（http(s) 转 intent 并返回 `null`；`about:blank` 等无 URL 目标仍交浏览器，登录弹窗靠 frame 的 `allow="…popups"`）、覆写 `navigator.clipboard.writeText`（先请顶层写，`__drgCapabilityReply` 回执 `{ id, ok }`；顶层拒绝时用 frame 自己的 `execCommand('copy')` 兜底，两者都失败才 reject 并发 `notify` 让顶层弹 toast）；全部安装成功后才置 `__drgCapabilityBridge`，半安装状态留给下一次加载重试。顶层：`switcher.dispatch` 的 `open-external` 经 `externalUrlOf` 只放行 http(s)，再 `win.open(url,'_blank','noopener,noreferrer')`（成功打开也返回 `null`，所以只有 URL 不合法时才弹 toast）；`clipboard-write` 用既有的 `copyText`（`writeText` 失败仍走 `execCommand`）并在 promise 里回执；`notify` 走 `toolStore.requestNotice` → 浮层 `notify`（已知 code 用本页文案，自由文本带「远端界面：」来源前缀）。浏览器 iframe 直接调用（promise 即回执），桌面 guest 走队列轮询并写回 `__drgCapabilityReply`。
- 存储分区：`mountGuestStorage(win, hostId)` 在浏览器载体每次加载后注入，把 frame 的 `localStorage` 换成带 `drg:<hostId>:` 前缀的 Storage 视图（`length`/`key`/`getItem`/`setItem`/`removeItem`/`clear`），并拦掉不属于本主机命名空间的 `storage` 事件。桌面 guest 有独立 `partition`，不需要这一层。
- 载体选择与窗口池：`carrierSurface()` 决定 `desktop`（有 `window.dshDesktop.browser`）或 `web`（没有桌面桥、且页面是 http/https）；两个后端实现同一组 `create / load / pushRow / waitReady / dispose / poll` 接口，共用 `carrierPool`（每主机一个载体，不设上限）、`showOverlay` 串行队列与 `wanted` 抢占语义。隐藏用 `display:none`；显示走 `revealCarrier`——先透明（`opacity:0` + `pointer-events:none`）挂上，桌面后端再等 `markCarrierReady`（`did-stop-loading`/主帧 `did-fail-load`）与 `GUEST_PAINT_SCRIPT` 两帧（`CARRIER_READY_TIMEOUT_MS` / `CARRIER_PAINT_TIMEOUT_MS` 兜底），`revealToken` 与 `carrierPool.current` 决定这次显示还算不算数，最后才变不透明；浏览器 iframe 自带已绘制内容，立即完成 `waitReady`，只保留同一次一帧过渡。`hideOverlays` 隐藏不销毁，`closeCarrier` 释放。`[data-shell-overlay]` 被抬到远端窗口之上（`.drg-root.drg-overlay` 自身不绘制），所以远端开着时浮窗也在最前。
- 数据：`GET /state` 为唯一真相，`EventSource /events` 实时推送、失败退化为 3s 轮询；常驻浮层宿主订阅一次，主机条与浮窗都读它。所有请求经 `apiRequest`，统一加 `x-dsh-remote-go: 1` 与 `credentials:'same-origin'`，错误转 `ErrorView`；i18n 用内置 `zh`/`en` 字典 + 宿主 locale 服务，两侧键集合由单元测试保证一致。
- 桌面接管：`showOverlay` 经 `window.dshDesktop.browser.acquire` 创建 guest，carrier 铺满整窗；`applyGuestCaption` 在每个 `dom-ready`/`did-stop-loading` 注入 `data-windows-titlebar`、高度与 `data-fullscreen`，`syncCarrierCaption` 决定让出标题栏或退回整体下移，并同步 `drg-carrier-grip` 拖拽条与 `html.drg-caption-live`；本地全屏状态由 `watchCaptionState` 的 MutationObserver 推给 guest；每次 `did-stop-loading` 在标题栏之后重注入主机条，`__drgBridgeQueue` 轮询用 `TAKE_INTENTS_SCRIPT` **一次取走并清空**（读/清分两次会吞掉落在中间的 intent），再把点击交回 `switcher.dispatch`。标题栏菜单的起点跟着**画这条带的那一页**走：`installSidebarMirror` 注入 `mountSidebarMirror`（`SIDEBAR_MIRROR_SCRIPT`），装载时返回 `{ collapsed, start }` 并在每次变化时把 `{ action:'caption-sidebar', collapsed, start }` 放进同一条队列——`start` 是 guest 里 DSH 自己解析出的 `--dsh-windows-menu-start`（收起 `84px`、展开为空），所以数值不靠复刻；`applyGuestSidebar` 记进 `entry.sidebarCollapsed` / `entry.sidebarStart`（`dom-ready` 时清空，新文档不继承旧 rail），`ownCaptionBand` 用 `setCaptionMenuStart` 把该值写成 `<html>` 内联变量，读不到时退回 48 / 84px 常量，回本地页时删掉、交还 DSH 自己的 `:has([data-sidebar-collapsed])` 规则（#63）。浏览器接管：`GET /hosts/:id/open` 的 `webUrl` 经 `isValidViewPath` 校验后赋给 iframe，`load` 事件里 `installWebCarrier` 设 `__drgBridgeSink`、调用 `mountHostRow` / `mountGuestTools` / `mountCapabilityBridge` / `mountGuestStorage`；桌面端在 `installGuestTools` 之后跑 `CAPABILITY_BRIDGE_SCRIPT`，安装成功也参与「要不要开始轮询」；没有标题栏与 caption 逻辑。
- API 客户端：`openHost(id)` 同时返回并校验 `url`（桌面回环地址）与 `webUrl`（浏览器同源路径）；只校验存在的字段，旧 Host 的响应不会阻塞桌面路径。
- 重启/重挂的承载：`RemoteView.viewRev` 变化（本地重启 / 远端重挂）后，热窗口重新取 `open`；即使 URL 相同也重新导航。`entry.viewRev` 只在**真正发生导航**后写入，旧 attach 的 URL 不会被重放。
- 主机卡片：已连接时在「断开」旁提供「重启远端 DSH」（`host-restart`）与「关闭远端 DSH」（`host-stop-remote`），
  `restarting-remote` / `stopping-remote` 期间两个按钮都禁用、卡片显示对应进度文案；「关闭」先弹
  `StopRemoteDialog`（破坏性确认，明示会停止远端进程并可重连），确认后走 `api.stopRemote`。重连按钮仍只出现在
  可重试状态（`disconnected` / `error` / `limited`），因为重启/关闭只在 `connected` 与可解释的
  `remote-unreachable` 错误下有效。
- 意图：`panelStore.requestIntent({ kind:'open'|'disconnect'|'manage'|'local' })` 与 `wizardStore.open({ mode, host })` 都由浮层宿主消费；`open` 走 `openHost`（未连接先连，清单留着看进度），`disconnect` 断开并释放窗口、Host 确认后交回本地，`manage` 开清单，`local` 隐藏远端窗口并清 Host 侧 active。意图订阅在挂载时建立，回调读不到最新窗口状态，「窗口在哪台」的收尾一律走 ref 或 `setState(fn)`。
- 安全不变量（测试读源码断言）：客户端自己不开任何窗口——唯一的新窗口调用点是能力桥的 `openExternalUrl`，只接受 http(s) 且先经 `externalUrlOf` 收窄；桌面路径不渲染 iframe；浏览器 iframe 只接受 `/dsh-remote-go/remote/<hostId>/` 形状的同源路径（无绝对 URL、`//`、反斜杠或 `..`）；token/URL 不写 localStorage；桌面只用回环 URL。文件内分区（`//#region`）：常量 → i18n 字典/助手 → 工具 → 错误视图 → API → 图标/原语 → 主机列表 → 连接窗口（进度 + 连接日志）/远端窗口 → 主机条 → 远端下载桥（`mountGuestTools`）→ 能力桥（`externalUrlOf` / `openExternalUrl` / `mountCapabilityBridge` / `mountGuestStorage`）→ 载体池（桌面 guest + 浏览器 frame 两个后端）→ 密钥选择器 → 添加/编辑主机 → 诊断 → 设置 → 密码/冲突 → toast → 浮层宿主（`PluginOverlay`，含可拖动下载卡）→ 样式 → 注册。

## 8. 测试、结构守卫与维护约定
| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数 | `util/version/ssh-config/known-hosts/redact/settings/local-version/probe/remote-files/local-download` | 解析、比较、指纹、脱敏、校验、远端路径、本机落盘与重名改名 |
| 准入栅栏 | `request-trust`（经 `api` / `remote-proxy` 用例覆盖） | `Host` 同源（loopback 互换、默认端口折算）、`Origin` 同源、`cross-site` 拒绝 |
| 运行时 | `node-runtime/bootstrap/remote-web/remote-proc/tunnel/ssh` | 托管 Node、npx 判定与命令模板、启动/收养、URL/token 握手、隧道、认证与指纹 |
| 同源代理 | `remote-proxy` | 视图路径解析、cookie jar / 路径与过期 / 按 remote authority 重置、Host/Origin 栅栏、准入拒绝（HTTP 与升级）、头部与 Location 改写、HTTP 转发、升级转发 |
| 服务 | `service/api/store/secrets/key-files/host-key/download-jobs/remote-restart/stop-remote` | 连接管线、指纹确认、冲突、重连/存活、重启状态机、关闭远端（状态机 + 归属授权 + registry 清理 + `keepAlive:"stop"` 不重复信号）、kill 授权与 `/proc` 身份校验、重挂后重启冲突、心跳确认、端口重解析与重挂、监听器重建（localProbe/先建后关/viewRev/退避/teardown 等待）、诊断、DSH 准入 / Host 自检 / SSE 鉴权、原子写、下载任务 |
| 浏览器 | `client.test.js` / `guards.test.js`（client-styles、client-compat） | 模块格式、slot 注册、双语对齐、安全不变量、两种载体、关键组件、重启/关闭按钮与 viewRev 重导航、CSS 卫生 |
| 模拟远端 | `test/integration/sim.test.js` + `e2e/sim` | 真实 SSH 端点、探针、forwardOut、认证/隧道守卫；远端 stop 真正关闭监听器与 token |
| 重启/重挂端到端 | `test/integration/remote-restart.test.js` | 真实 SSH + 真实隧道：本地重启换端口、远端自重启（stale registry）被重挂并刷新注册表；监听器重建与重挂后重启冲突在单测覆盖（含三种 keepAlive 的 disconnect 窗口与 removeHost/shutdown） |
| 关闭/重连端到端 | `test/integration/stop-remote.test.js` | 真实 SSH + 真实隧道：关闭停掉绑定的 pid、远端不再应答、`run/web.json` 清空，重连起新端口/新 token 且不弹冲突 |
| 按钮真实浏览器 | `test/integration/stop-remote.browser.test.js` | 真实 Chromium：卡片按钮 → 确认框（取消不请求）→ POST → `stopping-remote` 禁用态与进度文案 → 断线卡片可重连 |
| 模型工具 | `tools` | 注册/注销与输出契约、白名单投影（塞入带 password/token/fingerprint/`~/.ssh` 路径的假 host 断言不外泄）、`includeDisconnected` 过滤与计数、投影多一个字段即失败（planted regression）、服务异常转结构化错误、内核拒装不影响插件激活 |
| 代理端到端 | `test/integration/remote-proxy.test.js` | 隔离 `dsh web` 实例 → 同源代理 → 真实首页 / 插件资源 / WebSocket 升级 |
| 真实浏览器 | `test/integration/web.e2e.js` / `desktop.e2e.js` / `browser-carrier.test.js` | 打包产物装进隔离 `dsh web` / 桌面端 → 主机条浮窗 → 主题；浏览器载体 → 真实远端页面 + 注入主机条 + 本地意图 + 能力桥（真实点击链接触发顶层新标签、frame 内复制写入真实剪贴板并回执、按 hostId 分区的 localStorage） |

四条结构性约定（全部由 `test/unit/guards.test.js` 扫描源码强制）：

1. `swallow-guard`：任何把未知异常转成 `reason:` 的 `catch` 必须可区分（`internal-error`、error 级日志或重抛）或带 `// swallow-ok: <理由>`；递归扫 `src/**/*.js`。
2. `predicate-guard`：E2E 的等待谓词必须覆盖其后断言读取的字段；允许项必须有理由，条目失效判失败。
3. `e2e-child-process`：所有测试/脚本子进程必须 `windowsHide`。
4. `client-styles`：样式注释必须闭合、界面选择器必须有生效声明块；禁止 `--drg-*` 自有 token 与颜色字面量（含 `var()` 兜底）；对话框 / 菜单 / 输入框必须用宿主 Dialog / MenuSurface / 字段的 token 组合；引用的 `--dsw-*` 必须在白名单里。

## 9. 维护约定
- 文档引用**符号**，不写行号；重构后跑 `pnpm run verify` 发现断链。
- 新增远端 shell 命令必须走 `webapp.js` 固定模板，不接受调用方拼接的任意 shell。
- 远端下载只走 `remote-files.js` / `local-download.js` / `download-jobs.js`（绝对路径、文件或文件夹、SFTP）；不要把远端路径拼进 shell，也不要为“方便”开放任意目录浏览端点。不允许给文件大小、文件夹总字节或文件数量设上限：所有内容都从 SFTP 流式写进用户选择的本地目录，不打包 ZIP，也不写远端磁盘。
- 浏览器承载只走 `remote-proxy.js`：不代理任意 URL、不读远端 `~/.dsh`、不把远端 cookie 交给浏览器；新增可代理路径必须先落在 `REMOTE_VIEW_PREFIX` 下，并继续要求主机 `connected`。
- 新增可替换外部依赖从 `ServiceOptions` 注入（不要在 `service.js` 里直接 `new`）；新增 runtime 字段先改 `host-runtime.js`，新增对外字段先改 `host-view.js`，不要在管线里临时拼形状。
- 新增设置项同时更新 `settings.js` 的默认值/清洗、`docs/api.md` 的 SettingsView 与 `docs/design.md` 的界面说明；日志 `#log(runtime, level, …)` 的 `level` 是真实级别，信息性 trace 用 `debug`，不要用 `info` 刷屏。
- 重启 / 重挂必须复用已建立的 SSH 会话（不重跑 `[ssh]` / `[probe]` / `[bootstrap]`），只能停止 run registry 指向的本连接 pid；任何拿不准归属的进程都交给 `resolveForeignConflict`，不要用命令行模式匹配去 kill。远端端口是随机的，任何「换端口」路径都必须一起换隧道与 token，并把 `run/web.json` 刷新成真实值。
- 远端 `~/.dsh` 是远端用户自己的数据：本插件的任何代码都不应读写它（版本探测、启动/停止、日志与 run registry 除外），新增功能先确认不越过这条线。
- 新增模型工具或改它的返回字段：先改 `tools.js` 的字段白名单与 `output.schema`（`additionalProperties: false`，多一个字段就必须声明），再补 `test/unit/tools.test.js`。工具保持**只读**；确实要加写动作时，必须同时补上工具自带的确认门（不要挂在 `tools/pre-execute` 的 ask 上：`approval.policy='never'` 的会话会确定性拒绝），也不要让 `parameters` 出现密码 / 私钥内容 / token。
