# dsh-remote-go 实现

> 面向维护者：模块划分、连接管线、数据与测试。产品设计见 [design.md](design.md)，协议见 [api.md](api.md)。
> 本文只引用**符号名**，不引用行号——行号会随重构漂移。

## 1. 仓库结构

```text
dsh-remote-go
├─ index.js                 包入口：再导出 src/index.js
├─ client.js                浏览器半端（单文件、无构建、window.__ModuleLoader__ 注册）
├─ cordis.patch.yml         bundle 的 profile patch
├─ package.json             dsh.bundle.patch + dsh.client（web / immediately / inject）
├─ src/
│  ├─ index.js              Host 插件入口：挂 API、初始化 service、探测本机版本
│  ├─ api.js                本地 HTTP + SSE 路由（契约实现）
│  ├─ service.js            主机注册表、连接管线、公共 API facade（CRUD、设置、快照、诊断入口）
│  ├─ host-runtime.js       每主机 runtime 对象的唯一形状（建/用分开）
│  ├─ host-view.js          每主机对客户端的只读视图（HostView 投影）
│  ├─ diagnostics.js        9 项诊断检查表（只读投影，不新建连接）
│  ├─ ssh.js                ssh2 封装：指纹策略、认证回退、exec、forwardOut
│  ├─ ssh-config.js         ~/.ssh/config 解析与别名发现
│  ├─ known-hosts.js        known_hosts 只读解析 + OpenSSH SHA256 指纹
│  ├─ local-ssh.js          读取本机 ~/.ssh 材料（只读）
│  ├─ probe.js              远端环境探测（单条 POSIX sh，key<TAB>value）
│  ├─ bootstrap.js          npx 预检：环境判定、固定命令模板、版本回读
│  ├─ node-runtime.js       托管 Node：engines.node 下限解析、下载校验、安装/复用
│  ├─ webapp.js             远端 dsh web 生命周期：npx 启动/停止/收养、URL 解析、token 校验
│  ├─ tunnel.js             本地回环 TCP ↔ SSH forwardOut
│  ├─ store.js              hosts/settings/secrets 持久化与内存缓存
│  ├─ atomic-json.js        原子 JSON 写（tmp + wx + fsync + rename 重试）
│  ├─ settings.js           设置与主机条目的默认值/校验/清洗
│  ├─ secrets.js            DSH 凭据存储适配（密码不落 hosts.json）
│  ├─ layout.js             远端目录布局（~/.dsh 与插件状态目录）
│  ├─ version.js            版本解析/比较/Node 门槛
│  ├─ local-version.js      本机 DSH 版本探测（clientModules → env → package.json）
│  ├─ errors.js             分类错误（中英双语、下一步、技术细节）
│  ├─ redact.js             诊断脱敏
│  ├─ key-files.js          用户主目录内的私钥文件浏览
│  ├─ constants.js          默认值/常量
│  └─ util.js               通用工具（时间、延迟、日志级别、文本）
├─ locale/{zh,en}.json      插件市场显示元数据
├─ test/unit/               node:test 单元测试
├─ test/integration/        模拟远端集成 + 浏览器/桌面验收
├─ test/e2e/                发布路径验收（tarball → 干净 profile）
├─ e2e/sim/                 本机模拟远端主机（真实 SSH + HTTP stub）
├─ e2e/control/             隔离的 control DSH 运行时（发布路径验收用）
├─ e2e/remote/              真实测试主机的准备脚本
└─ scripts/                 仓库规范 / 市场条目 / 打包 / 语法检查
```

依赖方向是单向的：`index → service → (ssh / probe / node-runtime / bootstrap / webapp / tunnel / …)`；`service → (host-runtime / host-view / diagnostics / store / settings / …)`；低层模块不反向依赖 `service`。`api.js` 只依赖 `service` 的公开方法与 `errors`/`util`。

`host-runtime.js` 是 runtime 形状的唯一来源；`host-view.js` 是 `HostView` 的唯一投影；两者都不做 I/O，因此新增字段/视图只需要改一处。

## 2. Host 入口与装配

`src/index.js#apply(ctx, config)`：

1. 解析 `$DSH_HOME` 与插件状态目录，创建 `HostStore`。
2. 创建 `SecretStore`（可选：组合没有 `credentials` 服务时降级为仅内存）。
3. 创建 `RemoteGoService`，注入 store / home / logger / secrets / 本地版本 / 指纹确认超时。
4. `createApi({ service, getOrigin, logger, diagnostics })`，在 `ctx.effect` 内把 API 挂到 `webServer` 的 `/dsh-remote-go/api` 前缀上。
5. 异步 `service.init()` + `detectLocalVersion({ ctx })`；探测到版本就 `setLocalVersion`，否则记一条 warn。
6. 卸载时依次 `api.dispose()`、`service.shutdown()`、注销路由。

`optional = ['credentials']`：只有凭据存储是可选能力；其余依赖都是 node 内置模块或本仓库模块，发布包 `dependencies: {}`。

## 3. 连接管线

入口：`RemoteGoService#connect(id)` 只做参数登记（密码、是否保存密码），把 `runtime.connectPromise` 设为 `#connectPipeline(runtime)` 后立即返回；进度全部通过 `state` 事件广播。管线顺序：

```text
1. 清空上次的 error/warning/facts/exchange，status = connecting
2. #resolveTargetForRuntime：读本机 ssh 材料 → 解析别名 → 计算 known_hosts 指纹集合
3. 密码认证且勾选保存过：先从 SecretStore 取回密码（后台重连也不需要弹窗）
4. #openTransport：
   - 直接连接：sshFactory(buildOptions) → connect() → #captureFingerprint
   - 跳板机：先连跳板，再 forwardOut(target 22)，在通道上建第二条 ssh
   - onHostKey 回调进入 #onHostKey（严格策略直接拒绝；否则挂起等待 UI）
5. probeRemote：OS/Node/npm/npx/curl/磁盘/凭据/SSH 会话标记 → runtime.facts
6. ensureRemoteNode：按本机 `engines.node` 下限安装/复用 `~/.dsh/remote-go/node/v<version>`，失败即中止
7. applyManagedNodeFacts：把托管 Node 的 node/npm/npx 路径写回 facts
8. 本机版本未知则失败；planNpx 产出固定 npx 模板并绑定托管 Node 的 PATH → runtime.plan
9. 收养：adoptRemoteWeb 读 run registry（dshHome/profile/pid/日志 URL/HTTP 探活）
   - 版本不符且是本插件实例：stopRemoteWeb 后继续
10. 未收养则 #resolveForeignConflict：扫描非本插件 DSH 进程，暂停等待 stop/alongside/cancel
11. npx 预检（前台）：verifyNpxVersion，回读版本必须精确相等
12. startRemoteWeb：setsid nohup 启动，轮询 `dsh web:` 行取 pid/port/token
13. createTunnel：本地 127.0.0.1:0 → forwardOut(远端 port)
14. waitForRemoteUi（远端 curl 探活）→ exchangeTokenOverTunnel（token→cookie→干净首页）
15. connected：记录 lastOpenedAt/activeHostId，按设置保存 token/密码，挂断线处理器
16. 失败：toErrorView，按 desired 判断是「用户取消」还是「连接失败」，统一 teardown
```

teardown（`Service#teardownRuntime`）是唯一的收尾路径：取消指纹/冲突提示、置 `closing`、取消空闲计时器、按策略停远端、关隧道、释放 SSH、清空 probe/exchange/token/remote。disconnect`、`removeHost`、连接失败与 `shutdown` 都复用它。

## 4. SSH 与主机指纹

`ssh.js` 封装 ssh2：

- `hostVerifier(keyBlob, verify)` 计算 `SHA256:<base64>`，按 `pinnedFingerprint` / `knownHostFingerprints` / `hostKeyPolicy` 决策。
- 认证回退：私钥文件 →（密码认证时）密码；不支持 Agent。
- `exec(command, { timeoutMs })` 统一返回 `{ code, stdout, stderr }`；`forwardOut` 供隧道与跳板机使用。
- `onHostKey` 由 service 提供：`strict` 直接抛 `host-key-unknown`；否则把指纹挂到 runtime 并返回一个 promise，`confirmFingerprint()` 或超时后 resolve。

## 5. 版本一致性与托管 Node 运行时

- 本机版本：`local-version.js#detectLocalVersion` 依次尝试 `ctx.get('clientModules').graph().release.version`、`DSH_VERSION`/`DSH_RUNTIME_VERSION`、`@deepseek-ai/dsh/package.json`。
- 目标版本恒等于本机版本；`bootstrap.js#planNpx` 只产出 `npx -y @deepseek-ai/dsh@<version>` 的固定模板。
- 托管 Node 版本取本机 DSH `engines.node` 的下限；`node-runtime.js` 负责下载、SHA-256 校验、解压与复用。
- 预检与启动都写精确版本；`verifyNpxVersion` 把回读值与目标比较，不等即 `version-mismatch`。
- `webapp.js` 负责所有远端 shell 命令模板：启动脚本写 `logs/web.log`，读 `dsh web:` 行；`run/web.json` 只记录 pid/port/version/profile/dshHome（无 token）。

## 6. 本地 HTTP API

`api.js`：

- 挂载：`webServer.register({ kind: 'prefix', path: API_PREFIX, handler })`。
- 鉴权：`authorize()`（`x-dsh-remote-go: 1` + Origin 同源 + 拒绝 cross-site）；`/health` 开放，`/events` 只做 Origin 栅栏（EventSource 不能加头）。
- 请求体上限 1 MiB；错误统一 `{ ok:false, error: ErrorView }`，`invalid-input` → 400，其余业务错误 → 409，未知异常 → 500。
- SSE：`service.on('state', broadcast)`，连接时先推一帧，15s 一次 `ping`。
- 路由与字段见 [api.md](api.md)；`/diagnostics/self` 额外返回 Host 入口与 client-module 图行，用于验收/排障。

## 7. 持久化

本地 `$DSH_HOME/remote-go/`：

| 文件 | 内容 | 权限 |
|---|---|---|
| `hosts.json` | 主机清单（地址、认证、跳板机、存活策略、指纹 pin、时间戳） | 0600 |
| `settings.json` | 设置（见契约 SettingsView） | 0600 |
| `secrets.json` | 仅 `saveTokens=true` 时保存的 launch token | 0600 |

全部走 `atomic-json.js`：目录 0700、文件 0600、临时文件 `wx`、fsync、rename 重试、失败清理临时文件。密码不进 `hosts.json`，保存时写 DSH 凭据存储。

远端 `~/.dsh/remote-go/`：`logs/web.log`、`run/web.json`、`node/`、`downloads/`。远端 DSH 自己的数据始终在 `~/.dsh`。

## 8. Client 半端

`client.js` 是**单文件、无构建步骤**的浏览器插件：`window.__ModuleLoader__.load({ id, factory(require) })`，只 `require('react')`。

- 注册：`main` 面板、`settings.section`（order 45）、`sidebar.panellist`（order 20）。
- 数据：`GET /state` 为唯一真相，`EventSource /events` 实时推送，失败退化为 3s 轮询。
- API 层：所有请求经一个 `apiRequest`，统一加 `x-dsh-remote-go: 1` 与 `credentials:'same-origin'`；错误转成 `ErrorView`。
- i18n：内置 `zh`/`en` 字典 + 宿主 locale 服务；两侧键集合由单元测试保证一致。
- 接管：`openOverlay` 通过 `window.dshDesktop.browser.acquire` 创建 guest；`HOST_ROW_SCRIPT` 注入远端侧边栏；`__drgBridge` 轮询处理切主机/刷新/离开。
- 安全不变量（测试会读源码断言）：不打开外部窗口、不渲染 iframe、token/URL 不写 localStorage、只用回环 URL。
- 文件内部分区（`//#region`）：常量 → i18n → 工具 → 错误视图 → API → 图标/原语 → 主机列表 → 接管/承载 → 向导 → 诊断 → 设置 → 密码/冲突 → 面板 → 设置区 → 样式 → 注册。

## 9. 测试与结构守卫

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数 | `util/version/ssh-config/known-hosts/redact/settings/local-version/probe` | 解析、比较、指纹、脱敏、校验 |
| 运行时 | `node-runtime/bootstrap/webapp/tunnel/ssh` | 托管 Node、npx 判定与命令模板、URL/token 握手、隧道、认证与指纹 |
| 服务 | `service/api/store/secrets/key-files/host-key` | 连接管线、指纹确认、冲突、重连/存活、诊断、HTTP 鉴权/SSE、原子写 |
| 浏览器 | `client.test.js` / `client-compat` / `client-styles` | 模块格式、slot 注册、双语对齐、安全不变量、关键组件、CSS 卫生 |
| 模拟远端 | `test/integration/sim.test.js` + `e2e/sim` | 真实 SSH 端点、探针、forwardOut、认证/隧道守卫 |
| 真实浏览器 | `test/integration/web.e2e.js` / `desktop.e2e.js` | 打包产物装进隔离 `dsh web` / 桌面端 → 设置页 → 浅/深色对比度 |
| 发布路径 | `test/e2e/publish.e2e.js` | tarball → 干净 profile → API 与 client-module 从安装目录加载 |

四条结构性约定（见 CONTRIBUTING §9）：

1. `swallow-guard`：任何把未知异常转成 `reason:` 的 `catch` 必须可区分（`internal-error`、error 级日志或重抛）或带 `// swallow-ok: <理由>`；默认违规，递归扫 `src/**/*.js`。
2. `predicate-guard`：E2E 的等待谓词必须覆盖其后断言读取的字段；允许项必须有理由，且条目失效会被判失败。
3. `e2e-child-process`：所有测试/脚本子进程必须 `windowsHide`。
4. `client-styles`：样式表选择器与变量必须可解析，禁止内联样式散落。

## 10. 维护约定

- 文档引用**符号**，不写行号；重构后跑 `pnpm run verify` 即可发现断链。
- 新增远端 shell 命令必须走 `webapp.js` 的固定模板，不接受调用方拼接的任意 shell。
- 新增可替换的外部依赖从 `ServiceOptions` 注入；不要在 `service.js` 里直接 `new` 外部客户端。
- 新增 runtime 字段先改 `host-runtime.js`，新增对外字段先改 `host-view.js`；不要在管线里临时拼一个形状。
- 新增设置项要同时更新 `settings.js` 的默认值/清洗、`docs/api.md` 的 SettingsView、`docs/design.md` 的界面说明。
- 日志级别：`#log(runtime, level, …)` 的 `level` 是真实级别；信息性 trace 用 `debug`，不要用 `info` 刷屏。
