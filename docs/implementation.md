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
│  ├─ index.js              Host 插件入口：挂 HTTP API、初始化服务、探测本机 DSH 版本
│  ├─ api.js                本地 HTTP/SSE API（契约实现）
│  ├─ service.js            连接编排状态机（SSH→探测→自举→启动→隧道→校验）、诊断、存活策略
│  ├─ ssh.js                ssh2 封装：主机指纹策略、认证回退、exec（流式）、forwardOut
│  ├─ ssh-config.js         ~/.ssh/config 解析 / 别名发现 / 目标解析
│  ├─ known-hosts.js        known_hosts 只读解析 + OpenSSH SHA256 指纹
│  ├─ local-ssh.js          读取本机 ~/.ssh 材料（只读）
│  ├─ probe.js              远端环境探测（单条 POSIX sh，key<TAB>value 输出）
│  ├─ bootstrap.js          自举分级判定 + 白名单命令模板 + 执行/版本校验
│  ├─ webapp.js             远端 dsh web 生命周期：启动/停止/收养、URL 行解析、token→cookie 校验
│  ├─ tunnel.js             本地回环 TCP ↔ SSH forwardOut（ssh -L 等价）
│  ├─ store.js              本地持久化：$DSH_HOME/remote-go/{hosts,settings,secrets}.json（原子写/0600）
│  ├─ settings.js           设置与主机条目的默认值/校验/清洗
│  ├─ version.js            版本解析/比较/Node/Dsh 兼容判定
│  ├─ local-version.js      本机 DSH 版本探测（clientModules graph → env → package.json）
│  ├─ errors.js             分类错误（中英双语、下一步、技术细节）
│  ├─ redact.js             诊断脱敏（token/密码/私钥/家目录）
│  ├─ layout.js             远端目录布局（~ 展开由探测后的 home 决定）
│  └─ constants.js          默认值/常量
├─ locale/{zh,en}.json      插件市场显示元数据（meta.title/description）
├─ test/unit/*.test.js      node:test 单元测试（纯逻辑 + fake SSH/HTTP 服务）
├─ test/e2e/plugin.e2e.js   真实端到端验收
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

## 3. 数据与持久化

`$DSH_HOME/remote-go/`

| 文件 | 内容 | 权限 |
|---|---|---|
| `hosts.json` | 主机清单（显示名、address、port、username、auth.type/keyPath、jumpHost、存活策略、指纹 pin、自举配置、时间戳） | 0600 |
| `settings.json` | 设置（见契约 SettingsView） | 0600 |
| `secrets.json` | 仅 `saveTokens=true` 时保存的 launch token | 0600 |

写入为 tmp+rename 原子写；目录 0700；密码永不落盘。

远端（默认 `~/.dsh-remote-go/`）：`node/`（T3 下载的 Node）、`dsh-home/`（隔离安装的 DSH）、`home/`（远端 DSH_HOME）、`logs/web.log`、`run/web.json`。

## 4. Client 半端

- 注册：`main` 面板（key `dsh-remote-go`）+ `sidebar.panellist` 入口；`ctx.layout.selectPanel('dsh-remote-go')` 切换。
- 状态：`GET /state` 为唯一真相；`EventSource /events` 实时推送，失败退化 3s 轮询。
- 视窗：仅 `connected` 时 `GET /hosts/:id/open` 取一次性 token URL，校验 `http://127.0.0.1:` 前缀后赋给 iframe（sandbox 白名单）；URL/token 不进 localStorage/日志。
- UI：主机清单/空态、接入向导 3 步、指纹确认、密码弹窗（password 认证）、诊断抽屉、设置、错误卡片、断线 banner、首次提示；中英双语。
- `data-testid` 覆盖关键交互，供 E2E 使用。

## 5. 测试矩阵

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数 | `util/version/ssh-config/known-hosts/redact/settings/local-version/probe` | 解析、排序、指纹、脱敏、校验、版本探测 |
| 计划/命令 | `bootstrap/webapp` | T0–T5 判定、命令模板、URL 行、token→cookie 握手（本地假 DSH）、启动失败分类 |
| 存储/服务 | `store/service` | 原子持久化/密钥策略、连接管线（fake SSH/tunnel）、指纹确认、版本不一致、断线重连、存活策略、诊断清单 |
| HTTP | `api` | 鉴权（头/Origin/cross-site）、全部端点、SSE 首帧、错误码 |
| 浏览器 | `client.test.js`（VM + react-dom/server） | 模块格式、slot 注册、双语字典对齐、安全不变量、关键组件渲染、data-testid 覆盖、密码弹窗 |
| 真实端到端 | `test/e2e/plugin.e2e.js` | 真实 SSH → 真实远端 DSH → 隧道/ cookie → 无头 Chrome 面板 iframe；留证 report+截图 |
| 远端专项 | `e2e/remote/v0-report.md` | iframe 可行性闸门：cookie/XFO/CSP/WS/API 栅栏/断连存活 |

E2E 判定点：Host 入口在 client-module 图中且 bundle 可读；连接达到 `connected` 且 `versionParity=same`；`/open` 返回 loopback URL 且 token 兑换为 `SameSite=Strict` cookie；iframe 内是**远端** document（title/节点数/无本地文案泄漏）；清理停止远端并删除主机。

## 6. 设计取舍记录

1. **iframe 而非本地反代**：V0 实测同站 loopback 可行（`e2e/remote/v0-report.md`），避免 dsh-remote-window 式 portal 的 3–4 倍工作量；代价是浏览器对 iframe 的剪贴板/下载限制，用「在新窗口打开」兜底。
2. **本地 HTTP API 而非 typert Remote**：Host↔Client 只需少量端点；HTTP+SSE 无生成步骤、易测试，避免为 V1 引入 typert 生成链路。
3. **ssh2 而非系统 ssh**：需要程序化 host key（首次确认/变化中止）、密码认证、forwardOut 通道；系统 ssh 在 Windows 上无法安全地做一次性密码认证。
4. **自举不装系统级组件**：全部在用户目录，T5 明确失败不假装成功；白名单模板命令，不接受用户拼接 shell。
5. **不重复远端能力**：远端插件/凭据/设置都在远端界面里操作，本地不复制。
