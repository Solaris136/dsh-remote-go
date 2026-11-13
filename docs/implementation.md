# dsh-remote-go 实现说明（V1.0）

> 面向维护者：模块划分、关键流程、数据与状态、测试矩阵。产品内容见 `docs/design.md`，本地 Host↔Client 契约见 `docs/api.md`。

## 1. 总体结构

```text
dsh-remote-go（一个 bundle 包，Host + Client 两半）
├─ index.js                 → 导出 Host 插件 apply/inject（src/index.js 再导出）
├─ client.js                → window.__ModuleLoader__ 浏览器半端（单文件、无构建）
├─ cordis.patch.yml         → - insert: [{ id: dsh-remote-go, name: dsh-remote-go }]
├─ package.json             → dsh.bundle.patch + dsh.client{platform:'web',immediately:true,inject:[...]}
├─ src/
│  ├─ index.js              Host 插件入口：挂 HTTP API、初始化服务、探测本机 DSH 版本、装配会话/工作区适配器
│  ├─ api.js                本地 HTTP/SSE API（契约实现）
│  ├─ service.js            连接编排状态机（SSH→探测→自举→启动→隧道→校验）、诊断、存活策略、镜像同步编排
│  ├─ ssh.js                ssh2 封装：主机指纹策略、认证回退、exec（流式）、forwardOut
│  ├─ ssh-config.js         ~/.ssh/config 解析 / 别名发现 / 目标解析
│  ├─ known-hosts.js        known_hosts 只读解析 + OpenSSH SHA256 指纹
│  ├─ local-ssh.js          读取本机 ~/.ssh 材料（只读）
│  ├─ probe.js              远端环境探测（单条 POSIX sh，key<TAB>value 输出）
│  ├─ bootstrap.js          自举分级判定 + 白名单命令模板 + 执行/版本校验
│  ├─ webapp.js             远端 dsh web 生命周期：启动/停止/收养、URL 行解析、token→cookie 校验
│  ├─ tunnel.js             本地回环 TCP ↔ SSH forwardOut（ssh -L 等价）
│  ├─ mirror.js             镜像描述符模型：能力分级（L1/L2）、reconcile 计划、事件投影（applyEvents）、缺口检测
│  ├─ mirror-store.js       $DSH_HOME/remote-go/mirrors.json 的读写（按 host 分组，原子写/0600）
│  ├─ mirror-writer.js      描述符的**单写者**：每 host 一条队列 + 删除墓碑 + 单调字段合并（design §6.3）
│  ├─ history.js            远端会话日志的读取/解析/窗口计划（echo 分片、版本、折叠、缺口 → 类型化原因）
│  ├─ lease.js              写入租约：读/解析远端权威（`fetchRemoteLease`）、构造并发布自己的记录
│  │                        （`buildLeaseRecord` / `publishRemoteLease`）、释放墓碑、发布结果分类（design §6.2）
│  ├─ session-adapter.js    本地会话侧适配器：创建/查找镜像会话、append 事件、去重（mirrorSeq）
│  ├─ workspace-adapter.js  侧边栏工作区注册：每主机一个 `Remote: <主机名>` 分组
│  ├─ workspaces.js         本机 / 远端 DSH 的 storages/workspace.json 读取
│  ├─ store.js              本地持久化：$DSH_HOME/remote-go/{hosts,settings,secrets}.json（原子写/0600）
│  ├─ atomic-json.js        原子 JSON 写（临时名 + wx + fsync + 目录 fsync + 重命名重试）
│  ├─ settings.js           设置与主机条目的默认值/校验/清洗
│  ├─ version.js            版本解析/比较/Node/Dsh 兼容判定
│  ├─ local-version.js      本机 DSH 版本探测（clientModules graph → env → package.json）
│  ├─ errors.js             分类错误（中英双语、下一步、技术细节）
│  ├─ redact.js             诊断脱敏（token/密码/私钥/家目录）
│  ├─ layout.js             远端目录布局（~ 展开由探测后的 home 决定）
│  └─ constants.js          默认值/常量
├─ locale/{zh,en}.json      插件市场显示元数据（meta.title/description）
├─ test/unit/*.test.js      node:test 单元测试（纯逻辑 + fake SSH/HTTP 服务 + 三个结构性守卫）
├─ test/integration/        模拟远端集成/E2E（sim 主机、历史回放、租约、镜像、web/desktop 浏览器）
├─ test/e2e/publish.e2e.js  发布路径验收（tarball → 干净 profile）
└─ e2e/control/             隔离 control DSH（0.2.2-rc.1）运行时 + 启停脚本
```

## 2. 关键流程

### 2.1 连接管线（`service.js#connectPipeline`）

```text
connect(id)
  ├─ 解析目标：address → ~/.ssh/config 别名 → host/user/port/identityFiles；known_hosts 指纹集合
  ├─ [phase ssh]  ssh2 连接（主机指纹策略见 2.2；跳板机则先连跳板再 forwardOut 到目标 22）
  ├─ [phase probe] 远端探测（OS/Node/npm/npx/dsh/curl/tar/磁盘/凭据/SSH 会话标记/运行注册表）
  ├─ [phase bootstrap] 选择 T0/T0-local/T1/T2/T3 并执行白名单步骤；校验安装版本
  ├─ [phase start]  收养已有远端 web（run registry + 日志 URL + pid 存活 + HTTP 探测）
  │                  否则启动：setsid nohup + 日志 + 轮询 `dsh web:` 行 → pid/port/token
  ├─ [phase tunnel] net.Server(127.0.0.1:0) → 每连接 ssh.forwardOut(127.0.0.1:remotePort)
  ├─ [phase verifying] 远端 curl 探活 + 经隧道完成 token→cookie→干净首页 校验（无 XFO/CSP 阻塞）
  └─ connected：记录 lastOpenedAt、activeHostId；按设置用 0600 保存 token（默认不保存）
```

失败分类落到 `errors.js`（network/auth/host-key-changed/host-key-unknown/remote-dsh-missing/remote-dsh-start-failed/remote-ui-unreachable/version-mismatch/unsupported-os/invalid-input/internal），客户端据 code 展示文案与下一步。

### 2.2 主机指纹

- ssh2 `hostVerifier(keyBlob, verify)` 内计算 `SHA256:<base64>`（OpenSSH 形式）。
- 已记录指纹：匹配放行，变化 → `host-key-changed` 阻塞。
- 未记录且 known_hosts 有该主机条目：任意一条匹配即放行（等价 OpenSSH 行为）。
- 首次使用且无记录：`host-key-pending` 状态，等待 UI `POST /hosts/:id/fingerprint`（默认 120s 超时），接受后可记录；strict 策略直接拒绝。

### 2.3 版本一致性

- 本机版本：`ctx.clientModules.graph().release.version` → `DSH_VERSION` → `@deepseek-ai/dsh/package.json` 候选路径。
- 目标版本：设置 `bootstrap.targetVersion='local'`（默认）或显式精确版本。
- T0/T1 复用远端已装 DSH 时校验精确相等；不等则 `version-mismatch`（可显式 `overrideVersion` 继续并提示）。
- T2/T3 安装后回读版本再启动，不一致直接失败。

### 2.4 存活策略（设计 §16.4）

| 策略 | 本地断开时 | 本地 DSH 退出时 |
|---|---|---|
| `keep`（默认） | 只关隧道，远端继续 | 保留远端进程 |
| `stop` | 停止远端 web 后关隧道 | 停止远端 web |
| `idle` | 关隧道，N 分钟后停止远端（进程存活期间） | 保留（租约式清理为 V1.1 预留） |

远端启动时写 `~/.dsh-remote-go/run/web.json`（pid/port/version，无 token）；token 只存在于远端 0600 日志与本地内存，重连时由作者校验身份后从日志重新读取（收养）。

### 2.5 本地 HTTP API

- 挂载：`webServer.register({kind:'prefix', path:'/dsh-remote-go/api', handler})`。
- 鉴权：`x-dsh-remote-go: 1` 头 + Origin 同源 + 非 `sec-fetch-site: cross-site`；`/health` 开放、`/events`（EventSource 无法加头）只做 Origin 栅栏。
- 端点与字段见 `docs/api.md`；`/diagnostics/self` 返回 Host 入口与 client-module 图行（用于验收/排障）。

### 2.6 镜像会话层（L1 / L2，L3 未实现）

远端会话镜像成本地原生会话，分成三级能力（`src/mirror.js`）：L1 只做目录镜像（远端哪些会话存在），L2 在其上
回放历史（读远端会话日志），L3（事件流 / 输入转发 / 审批桥）**未实现**——传输尝试曾存在并在修复两个真实缺陷后
为收敛范围移除，状态是「未验证」而不是「已证伪」（`docs/session-design.md` §6.4 / §11）。

**L1 目录镜像**：`syncHostMirrors(id)`（`src/service.js:527`）读远端 `storages/workspace.json`
（`readRemoteWorkspaces`，`src/workspaces.js`），与本地描述符比对后 reconcile（`reconcileMirrors`，
`src/mirror.js:352`）；远端侧只读，不回写。远端已删除的会话保留描述符并标记 `remote-deleted`
（`src/mirror.js:368`），不删本地记录；读不到远端时同样保留上次快照（`src/service.js:582-584`）。
每个主机在侧边栏注册一个 `Remote: <主机名>` 工作区（`WORKSPACE_TITLE_PREFIX`，`src/workspace-adapter.js:34`），
镜像会话的 `meta.cwd` 指向 `$DSH_HOME/remote-go/mirrors/<hostId>`，这正是工作区归属的依据。

**L2 历史回放**：`#syncMirrorHistory`（`src/service.js:737`）对每个镜像发三次有界 SSH 命令（探测目录 → 发现日志
→ 读文件），解析与投影是纯函数（`src/history.js` 的 `fetchRemoteHistory` / `planHistoryWindow` /
`applyEvents`）。幂等靠两重：描述符 `cursor` 挡住重放，事件里的 `data.mirrorSeq` 挡住「append 成功但游标没落盘」。
保留窗口由 `mirrorMaxEvents`（默认 200，`0` = 不限）限制，只保留最新 N 条并在首次同步（`cursor === 0`）折叠前缀、
写一条 `mirror/history-folded` 通知；之后的溢出按缺口处理。

**描述符的单写者（design §6.3）**：所有描述符变更走 `withMirrorWriter`（`src/mirror-writer.js:28`）——
每主机一条 Promise 队列（`withMirrorQueue`，`src/mirror-writer.js:54`），**读 → 增量 → 持久化**在队列内完成，
因此两路写入（reconcile 与历史回放）不会互相覆盖 `cursor`。合并是**更新而不是 upsert**：`mergeDescriptorDeltas`
（`src/mirror-writer.js:80`）丢弃 `current` 里不存在的描述符（`:88`），并让 `cursor` / `epoch` / `conflictCount`
只增不减（`:93`）。删除走同一条队列（`#removeMirrorsForHost`，`src/service.js:2069`），且在**第一个 `await` 之前**
置墓碑 `runtime.mirrorDeleted = true`（`src/service.js:384`）；墓碑由 `withMirrorWriter` 在排队操作内部检查
（`src/mirror-writer.js:35`），所以删除前入队、删除后执行的写入也不会把镜像写回来——**队列负责顺序，墓碑负责结果，
两者都要**。

**写入租约与围栏（design §6.2，L3 前置）**：本地发布自己的 `{ writer, epoch, expiresAt, sessionKey }`
（`buildLeaseRecord` / `publishRemoteLease`，`src/lease.js:238` / `:364`），并读远端权威决定能否写
（`fetchRemoteLease`，`src/lease.js:190`）。被更高 epoch 接管时转为只读：`reason.code="fenced"`、`cursor` 不推进、
历史仍可读（`src/service.js:938-946`）。**注意**：远端的校验逻辑目前只由模拟远端实现（`e2e/sim`），未改造的真实 DSH
没有这段代码，所以「两个客户端只有一个能写」只在模拟远端下成立。

**三个结构性守卫（防止「全绿但静默坏掉」）**：`test/unit/swallow-guard.test.js`（任何产出 `reason:` 的 `catch`
必须可区分或带 `// swallow-ok: <≥2 词>`，默认违规、递归扫 `src/**/*.js`、判定前剥离注释）、
`test/unit/predicate-guard.test.js`（等待谓词必须覆盖其后的断言）、`test/unit/e2e-child-process.test.js`
（所有子进程必须 `windowsHide`）。约定与反例见 `CONTRIBUTING` §9。

## 3. 数据与持久化

`$DSH_HOME/remote-go/`

| 文件 | 内容 | 权限 |
|---|---|---|
| `hosts.json` | 主机清单（显示名、address、port、username、auth.type/keyPath、jumpHost、存活策略、指纹 pin、自举配置、时间戳） | 0600 |
| `settings.json` | 设置（见契约 SettingsView，含镜像开关与保留上限） | 0600 |
| `secrets.json` | 仅 `saveTokens=true` 时保存的 launch token | 0600 |
| `mirrors.json` | 镜像描述符（按 hostId 分组；`cursor` / `epoch` / `reason` / `status` 等，**不含** token 与堆栈） | 0600 |
| `mirrors/<hostId>/` | 镜像会话的 `meta.cwd` 指向的目录，用于把会话归入侧边栏的 `Remote: <主机名>` 工作区 | 0700 |

写入为 tmp+rename 原子写；目录 0700；密码永不落盘。

远端（默认 `~/.dsh-remote-go/`）：`node/`（T3 下载的 Node）、`dsh-home/`（隔离安装的 DSH）、`home/`（远端 DSH_HOME）、`logs/web.log`、`run/web.json`。

## 4. Client 半端

- 注册：`settings.section`「远程主机」（id `dsh-remote-go`，order 45）承载主机清单/添加/编辑/删除/连接/诊断；`sidebar.panellist`（order 20）是唯一的侧边栏入口，打开同一个主机管理页；`main` 面板（key `dsh-remote-go`）只承载主机管理页，点「打开」后由桌面端把远端 DSH 以 Chromium guest 接管侧边栏右侧的主内容区。`ctx.layout.selectPanel('dsh-remote-go')` 切换面板。
- 工作区接口：`GET /local/workspaces` + 每台主机 `GET /hosts/:id/workspaces`（Host 读取本机/远端 DSH 的 `storages/workspace.json`）。它们原本服务于面板内的工作区栏，该栏已移除；接口保留供镜像/诊断使用，面板不再渲染工作区列表。
- 市场显示名：`dsh remote go`（locale meta.title）；设置页栏目名「远程主机」（Remote hosts）。
- 状态：`GET /state` 为唯一真相；`EventSource /events` 实时推送，失败退化 3s 轮询。
- 呈现：仅 `connected` 时 `GET /hosts/:id/open` 取一次性 token URL，校验 `http://127.0.0.1:` 前缀后交给桌面端 Chromium guest（`<webview>`）；URL/token 不进 localStorage/日志。接管区自侧边栏右缘铺满主内容区，侧栏保持可交互，因此切换不需要任何浮层控件。
- UI：主机清单/空态、接入向导 3 步、指纹确认、密码弹窗（password 认证）、诊断抽屉、设置、错误卡片、断线 banner、首次提示；中英双语。
- `data-testid` 覆盖关键交互，供 E2E 使用。

## 5. 测试矩阵

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数 | `util/version/ssh-config/known-hosts/redact/settings/local-version/probe` | 解析、排序、指纹、脱敏、校验、版本探测 |
| 计划/命令 | `bootstrap/webapp` | T0–T5 判定、命令模板、URL 行、token→cookie 握手（本地假 DSH）、启动失败分类 |
| 镜像模型 | `mirror` / `mirror-writer` / `mirror-store` | reconcile（含 `remote-deleted` 标记与复活检测）、能力分级、事件投影与缺口、单写者串行、墓碑、单调合并、原子持久化 |
| 历史回放 | `history` | 日志发现/解析、版本与截断、窗口计划（折叠前缀 vs 缺口）、重复 seq 去重、`internal-error` 分类 |
| 租约 | `lease` / `mirror` | 记录构造/发布/释放命令、过期与 epoch 跳变分类、围栏状态机 |
| 存储/服务 | `store/service` | 原子持久化/密钥策略、连接管线（fake SSH/tunnel）、指纹确认、版本不一致、断线重连、存活策略、诊断清单、镜像同步编排与内部缺陷上报 |
| HTTP | `api` | 鉴权（头/Origin/cross-site）、全部端点、SSE 首帧、错误码 |
| 浏览器 | `client.test.js`（VM + react-dom/server） | 模块格式、slot 注册、双语字典对齐、安全不变量、关键组件渲染、data-testid 覆盖、密码弹窗 |
| 模拟远端集成 | `test/integration/*.e2e.js`（sim） | 模拟远端 → SSH → 探针/隧道、L1 目录镜像、L2 历史回放与缺口恢复、租约围栏（两个客户端只有一个能写） |
| 浏览器集成 | `test/integration/web.e2e.js` / `desktop.e2e.js` | 打包产物装进隔离 `dsh web` / 真实桌面端 → 设置页与面板 → 浅色/深色对比度 |
| 结构性守卫 | `swallow-guard` / `predicate-guard` / `e2e-child-process` | 吞错扫描（默认违规）、等待谓词覆盖断言、`windowsHide` 全覆盖 |

E2E 判定点：tarball 装进干净 profile 后 Host API 可访问、client-module 行从安装目录解析，报告写入 `e2e/artifacts/publish-e2e-report.json`。

## 6. 设计取舍记录

1. **桌面 guest 而非本地反代**：远端 DSH 由桌面端以 Chromium guest 铺在主内容区，避免 dsh-remote-window 式 portal 的 3–4 倍工作量，也没有 iframe 的剪贴板/下载限制（代价是 guest 自己禁用下载、拒绝权限请求）。
2. **本地 HTTP API 而非 typert Remote**：Host↔Client 只需少量端点；HTTP+SSE 无生成步骤、易测试，避免为 V1 引入 typert 生成链路。
3. **ssh2 而非系统 ssh**：需要程序化 host key（首次确认/变化中止）、密码认证、forwardOut 通道；系统 ssh 在 Windows 上无法安全地做一次性密码认证。
4. **自举不装系统级组件**：全部在用户目录，T5 明确失败不假装成功；白名单模板命令，不接受用户拼接 shell。
5. **不重复远端能力**：远端插件/凭据/设置都在远端界面里操作，本地不复制。
