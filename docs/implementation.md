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
│  ├─ index.js              Host 插件入口：挂 API、初始化 service、探测本机版本
│  ├─ api.js                本地 HTTP + SSE 路由（契约实现）
│  ├─ service.js            公共 facade：装配 ctx（依赖 + 可变状态）并委托给下面 6 个协作者
│  ├─ connect-pipeline.js   连接管线：目标解析 → transport → probe → 托管 Node → 同步 → 启动/收养 → 隧道 → 校验
│  ├─ sync-run.js           同步阶段：prepare（读两侧快照、计划、哈希）与 apply（备份、写入、装插件、校验、回滚）
│  ├─ sync-plan.js          同步计划（纯函数）：插件/配置行/凭据分类、合并动作与计划哈希
│  ├─ sync-local.js         本机快照：profile manifest、patch 行、`~/.dsh/.credentials.yaml`
│  ├─ sync-credentials.js   凭据合并：refs 本地覆盖、records 只增、未知顶层键保留
│  ├─ sync-remote.js        远端固定命令模板：快照读取、stdin 写文件、备份/恢复、pnpm 准备、插件安装与校验
│  ├─ host-registry.js      主机 CRUD、设置、快照、key-file 浏览与 ssh 别名发现
│  ├─ host-lifecycle.js     重连/空闲计时器、唯一 teardown 路径、shutdown
│  ├─ connect-progress.js   日志环、/state 合并、进度码与 npx 行解析
│  ├─ prompts.js            指纹确认与远端冲突的用户决定 rendezvous
│  ├─ host-runtime.js       每主机 runtime 对象的唯一形状（建/用分开）
│  ├─ host-view.js          每主机对客户端的只读视图（HostView 投影）
│  ├─ connect-log.js        连接日志：环形缓冲下限、对外日志尾与可见状态
│  ├─ diagnostics.js        10 项诊断检查表（只读投影，不新建连接）
│  ├─ ssh.js                ssh2 封装：指纹策略、认证回退、exec、forwardOut
│  ├─ ssh-config.js         ~/.ssh/config 解析与别名发现
│  ├─ known-hosts.js        known_hosts 只读解析 + OpenSSH SHA256 指纹
│  ├─ local-ssh.js          读取本机 ~/.ssh 材料（只读）
│  ├─ probe.js              远端环境探测（单条 POSIX sh，key<TAB>value）
│  ├─ bootstrap.js          npx 预检：环境判定、固定命令模板、版本回读
│  ├─ node-runtime.js       托管 Node：engines.node 下限解析、下载校验、安装/复用
│  ├─ webapp.js             远端 web 生命周期的公开再导出面（remote-web / remote-proc）
│  ├─ remote-web.js         远端 dsh web 启动/停止/收养、启动脚本与 URL 解析
│  ├─ remote-proc.js        进程扫描、foreign DSH、探活与 token 交换
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
依赖方向单向：`index → service`；`service` 建好 `ctx` 后委托 `host-registry` / `connect-pipeline` / `host-lifecycle` / `connect-progress` / `prompts`。`connect-pipeline → host-lifecycle / prompts / connect-progress`，`host-lifecycle` 不依赖 pipeline（重连由 pipeline 发起），`prompts`/`connect-progress` 是叶子；低层模块不反向依赖 `service`，`api.js` 只依赖 `service` 的公开方法与 `errors`/`util`。`host-runtime.js` 是 runtime 形状的唯一来源，`host-view.js` 是 `HostView` 的唯一投影，日志尾长度与可见状态由 `connect-log.js` 决定；三者都不做 I/O，新增字段或视图只改一处。

## 2. Host 入口与装配
`src/index.js#apply(ctx, config)`：解析 `$DSH_HOME` 与插件状态目录 → `HostStore` → `SecretStore`（没有 `credentials` 服务时降级为仅内存）→ `RemoteGoService`（注入 store/home/logger/secrets/本地版本/指纹确认超时）→ `createApi({ service, getOrigin, logger, diagnostics })` 在 `ctx.effect` 内挂到 `webServer` 的 `/dsh-remote-go/api` 前缀 → 异步 `service.init()` + `detectLocalVersion`/`detectLocalEnginesNode`（读不到版本记 warn）→ 卸载时 `api.dispose()`、`service.shutdown()`、注销路由。`optional = ['connection','credentials']`；其余依赖都是 node 内置模块或本仓库模块，发布包 `dependencies: {}`。

## 3. 连接管线
入口 `RemoteGoService#connect(id)` 只登记参数（密码、是否保存），交给 `connect-pipeline.js#startConnect`，把 `runtime.connectPromise` 设为 `connectPipeline(ctx, runtime)` 后立即返回；进度全走 `state` 事件。顺序：

```text
1. 清空上次 error/warning/facts/exchange，status = connecting
2. resolveTarget：本机 ssh 材料 → 别名解析 → known_hosts 指纹集合；已保存过密码则从 SecretStore 取回（后台重连无需弹窗）
3. openTransport：直接 sshFactory(buildOptions) → connect → captureFingerprint；跳板机先连跳板再 forwardOut(target 22)，通道上建第二条 ssh；onHostKey 进入 prompts.requestHostKey（strict 直接拒绝，否则挂起等 UI）
4. probeRemote：OS/Node/npm/npx/curl/磁盘/凭据/SSH 会话标记 → runtime.facts；ensureRemoteNode 按 engines.node 下限装/复用 ~/.dsh/remote-go/node/v<version>（失败即中止），applyManagedNodeFacts 写回 node/npm/npx 路径
5. 本机版本未知则失败；planNpx 产出固定模板并绑定托管 Node 的 PATH
6. adopt：读 run registry（dshHome/profile/pid/日志 URL/HTTP 探活），版本不符的本插件实例先 stop 再另起；未收养才继续：清掉不可收养的残留实例 → resolveForeignConflict 扫描外来 DSH（stop/alongside/cancel）
7. sync prepare（勾选时）：readLocalSnapshot + 远端快照 → planSync → planHash；adopt 分支用哈希决定是否先停掉过期实例
8. npx 预检（前台，无超时）：verifyNpxVersion 回读必须精确相等
9. sync apply（勾选时）：tar 备份 → 合并凭据/profile patch → 准备 pnpm → 逐包 `dsh plugin add` → `--dump-config` 校验 → 写 `sync/state.json`；失败回滚，回滚失败才中止
10. startRemoteWeb：setsid nohup 启动，轮询 `dsh web:` 行取 pid/port/token；createTunnel：本地 127.0.0.1:0 → forwardOut(远端 port)
11. waitForRemoteUi（远端 curl）→ exchangeTokenOverTunnel（token→cookie→干净首页）
12. connected：记录 lastOpenedAt/activeHostId，按设置保存 token/密码，挂断线处理器（host-lifecycle.scheduleReconnect）
13. 失败：toErrorView，按 desired 判定「用户取消」/「连接失败」，统一 teardown
```

teardown（`host-lifecycle.js#teardownRuntime`）是唯一收尾路径：取消冲突提示、置 `closing`、取消空闲计时器、按策略停远端、关隧道、释放 SSH、清空 probe/exchange/token/remote；`disconnect`、`removeHost`、连接失败与 `shutdown` 都复用它。

## 4. SSH、指纹与运行时
`ssh.js` 封装 ssh2：`hostVerifier` 计算 `SHA256:<base64>`，按 `pinnedFingerprint` → `knownHostFingerprints` → `hostKeyPolicy` 决策；认证回退只有私钥文件 →（密码认证时）密码，不支持 Agent；`exec(command,{timeoutMs,stdin})` 统一返回 `{ code, stdout, stderr }`（`stdin` 供同步上传文件，避免凭据出现在远端命令行），`forwardOut` 供隧道与跳板机。`onHostKey` 由 service 提供：`strict` 直接抛 `host-key-unknown`，否则把指纹挂到 runtime 并返回 promise，`confirmFingerprint()` 或 120s 超时后 resolve。

- 本机版本：`local-version.js#detectLocalVersion` 依次 `DSH_VERSION`/`DSH_RUNTIME_VERSION`、`clientModules.graph().release.version`、`@deepseek-ai/dsh/package.json`；目标版本恒等于本机版本。
- `bootstrap.js#planNpx` 只产出 `npx -y @deepseek-ai/dsh@<version>` 固定模板，`verifyNpxVersion` 回读不等即 `version-mismatch`。
- 托管 Node 版本取本机 DSH `engines.node` 下限（`node-runtime.js` 负责下载、SHA-256 校验、解压与复用）；`remote-web.js` 持有全部远端 shell 命令模板：启动脚本写 `logs/web.log` 并读 `dsh web:` 行，`run/web.json` 只记录 pid/port/version/profile/dshHome/launch 标记（无 token）。

## 5. 本地 HTTP API
`api.js`：`webServer.register({ kind:'prefix', path:API_PREFIX, handler })`；`authorize()`（`x-dsh-remote-go: 1` + Origin 同源 + 拒绝 cross-site），`/health` 开放、`/events` 只做 Origin 栅栏（EventSource 不能加头）；请求体上限 1 MiB；错误统一 `{ ok:false, error:ErrorView }`，`invalid-input`→400、其余业务错误→409、未知异常→500；SSE 在 `service.on('state')` 广播，连接先推一帧、15s 一次 `ping`。路由与字段见 [api.md](api.md)；`/diagnostics/self` 额外返回 Host 入口、`engines.node` 与 client-module 图行，用于验收/排障。

## 6. 持久化
本地 `$DSH_HOME/remote-go/`：

| 文件 | 内容 | 权限 |
|---|---|---|
| `hosts.json` | 主机清单（地址、认证、跳板机、存活策略、指纹 pin、时间戳） | 0600 |
| `settings.json` | 设置（见契约 SettingsView） | 0600 |
| `secrets.json` | 仅 `saveTokens=true` 时保存的 launch token | 0600 |

全部走 `atomic-json.js`：目录 0700、文件 0600、临时文件 `wx`、fsync、rename 重试、失败清理临时文件。密码不进 `hosts.json`，保存时写 DSH 凭据存储。远端 `~/.dsh/remote-go/`：`logs/web.log`、`run/web.json`、`node/`、`downloads/`、`pnpm/` 与 `bin/`（同步用的 pnpm 与 shim）、`sync/`（`state.json` 计划哈希与备份 tar）；远端 DSH 自己的数据始终在 `~/.dsh`。

## 7. Client 半端
`client.js` 是**单文件、无构建**的浏览器插件：`window.__ModuleLoader__.load({ id, factory(require) })`，只 `require('react')`。

- 注册：只注册 `shell.overlay`（唯一浮层宿主：管理清单 / 向导 / 提示）与主机条；不注册 `settings.section`、`main` 主面板或侧边栏任何行。主机条：`mountHostRow(win)` 是唯一实现——本地页面直接调用，远端 guest 里跑 `HOST_ROW_SCRIPT = '(' + mountHostRow.toString() + ')(window)'`；每 1.5s（`SWITCHER_TICK_MS`）用 `updateSwitcher` 推状态，按 `[data-window-drag]` 找侧边栏，页面重渲染后行自动回位。
- 远端窗口池：`carrierPool`（每主机一个 `<webview>` + 独立 partition，不设上限）；`showOverlay` 串行执行并记住 `wanted`，复用热窗口、只切 `display`；`hideOverlays` 隐藏不销毁，`closeCarrier` 释放。`[data-shell-overlay]` 被抬到远端窗口之上（`.drg-root.drg-overlay` 自身不绘制），所以远端开着时浮窗也在最前。
- 数据：`GET /state` 为唯一真相，`EventSource /events` 实时推送、失败退化为 3s 轮询；常驻浮层宿主订阅一次，主机条与浮窗都读它。所有请求经 `apiRequest`，统一加 `x-dsh-remote-go: 1` 与 `credentials:'same-origin'`，错误转 `ErrorView`；i18n 用内置 `zh`/`en` 字典 + 宿主 locale 服务，两侧键集合由单元测试保证一致。
- 接管：`showOverlay` 经 `window.dshDesktop.browser.acquire` 创建 guest，carrier 铺满整窗；`applyGuestCaption` 在每个 `dom-ready`/`did-stop-loading` 注入 `data-windows-titlebar`、高度与 `data-fullscreen`，`syncCarrierCaption` 决定让出标题栏或退回整体下移，并同步 `drg-carrier-grip` 拖拽条与 `html.drg-caption-live`；本地全屏状态由 `watchCaptionState` 的 MutationObserver 推给 guest；每次 `did-stop-loading` 在标题栏之后重注入主机条，`__drgBridgeQueue` 轮询把点击交回 `switcher.dispatch`。
- 意图：`panelStore.requestIntent({ kind:'open'|'disconnect'|'manage'|'local' })` 与 `wizardStore.open({ mode, host })` 都由浮层宿主消费；`open` 走 `openHost`（未连接先连，清单留着看进度），`disconnect` 断开并释放窗口、Host 确认后交回本地，`manage` 开清单，`local` 隐藏远端窗口并清 Host 侧 active。意图订阅在挂载时建立，回调读不到最新窗口状态，「窗口在哪台」的收尾一律走 ref 或 `setState(fn)`。
- 安全不变量（测试读源码断言）：不开外部窗口、不渲染 iframe、token/URL 不写 localStorage、只用回环 URL。文件内分区（`//#region`）：常量 → i18n 字典/助手 → 工具 → 错误视图 → API → 图标/原语 → 主机列表 → 连接窗口（进度 + 连接日志）/远端窗口 → 主机条 → 密钥选择器 → 添加/编辑主机 → 诊断 → 设置 → 密码/冲突 → toast → 浮层宿主（`PluginOverlay`）→ 样式 → 注册。

## 8. 测试、结构守卫与维护约定
| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数 | `util/version/ssh-config/known-hosts/redact/settings/local-version/probe` | 解析、比较、指纹、脱敏、校验 |
| 运行时 | `node-runtime/bootstrap/remote-web/remote-proc/tunnel/ssh` | 托管 Node、npx 判定与命令模板、启动/收养、URL/token 握手、隧道、认证与指纹 |
| 服务 | `service/api/store/secrets/key-files/host-key` | 连接管线、指纹确认、冲突、重连/存活、诊断、HTTP 鉴权/SSE、原子写 |
| 同步 | `sync.test.js`（`sync-plan/sync-credentials/sync-remote/sync-local`） | registry 判定、可移植性、行/凭据分类与合并、计划哈希、远端快照解析、命令引用与 stdin、主机字段与 HostView |
| 浏览器 | `client.test.js` / `guards.test.js`（client-styles、client-compat） | 模块格式、slot 注册、双语对齐、安全不变量、关键组件、CSS 卫生 |
| 模拟远端 | `test/integration/sim.test.js` + `e2e/sim` | 真实 SSH 端点、探针、forwardOut、认证/隧道守卫 |
| 真实浏览器 | `test/integration/web.e2e.js` / `desktop.e2e.js` | 打包产物装进隔离 `dsh web` / 桌面端 → 主机条浮窗 → 浅/深色对比度、第三方主题 token 覆盖与恢复（同时覆盖发布路径的 tarball 安装） |

四条结构性约定（全部由 `test/unit/guards.test.js` 扫描源码强制）：

1. `swallow-guard`：任何把未知异常转成 `reason:` 的 `catch` 必须可区分（`internal-error`、error 级日志或重抛）或带 `// swallow-ok: <理由>`；递归扫 `src/**/*.js`。
2. `predicate-guard`：E2E 的等待谓词必须覆盖其后断言读取的字段；允许项必须有理由，条目失效判失败。
3. `e2e-child-process`：所有测试/脚本子进程必须 `windowsHide`。
4. `client-styles`：样式注释必须闭合、界面选择器必须有生效声明块；禁止 `--drg-*` 自有 token 与颜色字面量（含 `var()` 兜底）；对话框 / 菜单 / 输入框必须用宿主 Dialog / MenuSurface / 字段的 token 组合；引用的 `--dsw-*` 必须在白名单里。

## 9. 维护约定
- 文档引用**符号**，不写行号；重构后跑 `pnpm run verify` 发现断链。
- 新增远端 shell 命令必须走 `webapp.js` 固定模板，不接受调用方拼接的任意 shell。
- 新增可替换外部依赖从 `ServiceOptions` 注入（不要在 `service.js` 里直接 `new`）；新增 runtime 字段先改 `host-runtime.js`，新增对外字段先改 `host-view.js`，不要在管线里临时拼形状。
- 新增设置项同时更新 `settings.js` 的默认值/清洗、`docs/api.md` 的 SettingsView 与 `docs/design.md` 的界面说明；日志 `#log(runtime, level, …)` 的 `level` 是真实级别，信息性 trace 用 `debug`，不要用 `info` 刷屏。
- 同步的新规则先改 `sync-plan.js`（纯函数）并补 `sync.test.js`：插件可同步判定、行选中/可移植性、凭据合并口径都只在那里定义；远端命令模板只放 `sync-remote.js`，不接受调用方拼接 shell；凭据值只经 `ssh.exec` 的 `stdin` 传输。
