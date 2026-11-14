# dsh-remote-go 设计

> 本文描述**当前实现的产品设计**：目标、职责边界、界面、连接生命周期、远端运行时与安全。
> 代码结构见 [implementation.md](implementation.md)，协议见 [api.md](api.md)。

## 1. 目标

在本地 DSH 里，用一条 SSH 连接打开**服务器上原版 DSH 的完整界面**，像 VS Code Remote-SSH 一样工作：

- 主机在本地统一管理（增删改、连接、诊断），不需要在远端安装本插件。
- 远端界面在本地窗口里**整窗呈现**，本地不复制、不代理远端 UI 字节。
- 远端数据就是该用户自己的 `~/.dsh`：凭据、会话、工作区与直接在远端使用 DSH 完全一致。
- 远端运行时只有一条路径：**插件托管的 Node + `npx`**，DSH 版本与本机**精确一致**；不依赖、不修改系统 Node。

## 2. 非目标

- 不做本地反代、iframe 内嵌或第二个浏览器窗口。
- 不做沉浸模式、本机通知、多窗口分屏。
- 不管理远端插件、远端设置或远端凭据（这些在远端界面里操作）。
- 不迁移旧版的隔离运行时目录。

## 3. 职责边界

| 能力 | 本地（本插件） | 远端（原版 DSH） |
|---|---|---|
| 主机清单 / 向导 / 诊断 | ✅ | — |
| SSH 认证、主机指纹、跳板机 | ✅ | — |
| 启动 / 收养 / 停止远端 `dsh web` | ✅ | — |
| 本地回环隧道 | ✅ | — |
| 界面呈现 | 提供承载与主机条 | 渲染完整 DSH Web UI |
| 数据（会话、工作区、凭据） | 只读版本/诊断信息 | ✅ 用户自己的 `~/.dsh` |

本地只持有**连接状态**与**一次性 launch token**；远端界面、业务数据与会话内容都不经过本地 HTTP API。

## 4. 界面

### 4.1 设置页「远程主机」

`settings.section`（id `dsh-remote-go`，order 45）承载主机管理页：

- 主机清单：名称、地址、状态、远端版本、上次打开时间。
- 每台主机的动作：打开、连接 / 断开 / 重连、诊断、编辑、删除。
- 添加主机：打开 3 步接入向导。

### 4.2 侧边栏入口

`sidebar.panellist`（order 20）只有一行「远程主机」，打开同一个主机管理页；不按主机拆行，也没有浮层控件。

### 4.3 主机管理页

`main` 面板（key `dsh-remote-go`）只承载主机管理页，是侧边栏入口与设置页共用的目标。面板本身不渲染远端界面。

### 4.4 整窗接管与主机条

点「打开」后，客户端：

1. 通过 `GET /hosts/:id/open` 取一次性 token 的本地回环 URL，校验 `http://127.0.0.1:` 前缀。
2. 经桌面桥 `window.dshDesktop.browser.acquire` 取得 guest lease，创建 Chromium guest（`<webview>`）铺满标题栏以下的整个窗口；本地侧边栏让位。
3. guest 每次加载完成（`did-stop-loading`）后，向远端页面注入主机条脚本，并通过 `window.__drgBridge` 轮询把主机列表、当前主机、远端会话标题推给页面。

主机条是**远端页面 DOM 的一部分**（侧边栏品牌的下一行），因此继承远端主题、字体、hover 与弹层遮罩；菜单里提供切换主机、刷新远端界面、离开远端。它是接管期间唯一的本地控件。

离开远端只关闭承载，不断开 SSH、不停远端任务；回到主机管理页后可以重新打开或选择另一台。

### 4.5 接入向导

3 步：SSH 信息 → 连接测试 → 完成。

- SSH 信息：地址 / 别名、端口、用户名、认证（私钥文件或密码）、跳板机、存活策略。
- 连接测试：调用连接并在页面内展示分阶段进度、指纹确认、冲突提示与错误卡片。
- 完成：编辑模式保存即返回；新建模式展示连接结果，可继续打开界面。

### 4.6 诊断与设置

- 诊断抽屉：9 项固定检查（SSH 可达性、认证、指纹、隧道、远端服务、远端界面、版本、模型凭据、远端桌面守卫），支持复制脱敏报告。
- 设置弹窗：SSH 默认值、自动重连、指纹策略、保存令牌开关、界面语言、日志级别、远端 `profile`。
- 密码与远端冲突按需弹窗；两者都有超时兜底（默认 120s）。

## 5. 连接生命周期

### 5.1 主机状态

| status | 含义 |
|---|---|
| `unconfigured` | 尚未连接过 |
| `connecting` | 连接中（配合 phase / progress） |
| `fingerprint-pending` | 等待用户确认主机指纹 |
| `conflict-pending` | 远端已有手工启动的 DSH，等待用户选择 |
| `connected` | 远端界面可用 |
| `disconnected` | 断线，可重连 |
| `error` | 连接/认证/服务失败 |
| `limited` | 保留状态：能连但远端无法提供界面 |

### 5.2 阶段与进度

`phase` 取值：`ssh` → `probe` → `bootstrap` → `start` → `tunnel` → `verifying` → `ready`。

进度码是细粒度、可本地化的 `{ code, params }`；具体列表以 [api.md](api.md) 为准。客户端只按 code 查文案，不推断连接逻辑。

### 5.3 连接流程

```text
connect(id)
  ├─ 解析目标：address → ~/.ssh/config 别名 → host/user/port/identityFiles；known_hosts 指纹集合
  ├─ [ssh]     ssh2 连接（指纹策略见 §5.4；跳板机先连跳板再 forwardOut 到目标 22）
  ├─ [probe]   远端探测：OS / Node / npm / npx / curl / 磁盘 / 凭据 / SSH 会话标记
  ├─ [bootstrap] 托管 Node：按本机 DSH `engines.node` 下限安装/复用 `~/.dsh/remote-go/node/v<version>`
  ├─ [start]   先收养本插件上次留下的远端 web（run registry 的 dshHome/profile 匹配 + pid 存活 + 日志 URL）
  ├─ [start]   未收养时扫描同一 ~/.dsh 下其他 DSH 进程；命中则暂停为 conflict-pending
  ├─ [bootstrap] npx 预检：托管 Node 的 `npx -y @deepseek-ai/dsh@<本机版本> --version`，回读必须相等
  ├─ [start]   启动：`env DSH_HOME=~/.dsh PATH=<managed node bin> npx -y @deepseek-ai/dsh@<本机版本> --profile <profile> --no-open --port 0`
  ├─ [tunnel]  net.Server(127.0.0.1:0) → 每连接 ssh.forwardOut(127.0.0.1:remotePort)
  ├─ [verifying] 远端 curl 探活 + 经隧道完成 token→cookie→干净首页 校验
  └─ connected：记录 lastOpenedAt、activeHostId；按设置保存 token（默认不保存）
```

任一步失败都会落入分类错误（见 [api.md](api.md) 的 `ErrorView.code`），并执行同样的 teardown：关隧道、按策略决定是否停远端、清理状态。

### 5.4 主机指纹

- ssh2 `hostVerifier` 内计算 OpenSSH 形式的 `SHA256:<base64>`。
- 已记录指纹：匹配放行；变化 → `host-key-changed` 阻塞。
- 未记录且 known_hosts 有该主机条目：任意一条匹配即放行（等价 OpenSSH）。
- 首次使用且无记录：`fingerprint-pending`，等待 `POST /hosts/:id/fingerprint`；超时按拒绝处理。
- `strict` 策略直接拒绝未知指纹，不弹窗。

### 5.5 断线、重连与退出

- SSH 连接 `close` 且用户期望保持连接时：状态转 `disconnected`，按设置做指数退避重连（`autoReconnect.maxAttempts`）。
- 手动断开：关隧道；`keepAlive=stop` 同时停远端，`idle` 延迟停止，`keep` 保留远端。
- 删除主机：先取消重连/空闲计时器，再 teardown，最后删记录；远端按该主机的存活策略处理。
- 本地 DSH 退出：`shutdown()` 对每台主机执行同样的 teardown。

## 6. 远端运行时

### 6.1 托管 Node + npx

只有一条路径：插件把**自己的 Node** 装到 `~/.dsh/remote-go/node/v<version>`，再用它的 `npx -y @deepseek-ai/dsh@<本机版本>` 拉起 DSH。

- 版本 = 本机 DSH `engines.node` 的下限（当前 24.9.0），随 DSH 读取、固定复用，不追最新补丁。
- 官方 `nodejs.org/dist` 的 tarball，先校验 `SHASUMS256.txt` 的 SHA-256 再解压；官方源不可达时回退 npmmirror 的同一版本。
- 永不使用系统 Node、不需要 root；没有系统 Node 兜底，装不上就明确失败。
- 安装/复用同一版本后清理旧版本；没有自举分级、没有离线包。

### 6.2 版本一致

- 本机版本来源：`clientModules.graph().release.version` → `DSH_VERSION` / `DSH_RUNTIME_VERSION` → `@deepseek-ai/dsh/package.json`。
- 目标版本**恒等于本机版本**；没有 override/target 设置。托管 Node 版本则由本机 DSH 的 `engines.node` 下限决定。
- 预检回读不一致 → `version-mismatch`，连接中止。
- 收养旧进程前校验 run registry（`dshHome`、`profile`、版本）；版本不符且属于本插件时先停止再另起。

### 6.3 收养与冲突

- 收养：读插件状态目录的 `run/web.json`，要求 pid 存活、日志 URL 可解析、HTTP 可达。收养让本地重启后复用远端实例。
- 冲突：远端已有手工启动的 DSH 时，列出进程并让用户选 `stop` / `alongside` / `cancel`；`alongside` 会在主机卡片留下共享 `~/.dsh` 的 warning。

### 6.4 存活策略

| 策略 | 本地断开时 | 本地 DSH 退出时 |
|---|---|---|
| `keep`（默认） | 只关隧道，远端继续 | 保留远端进程 |
| `stop` | 停止远端 web 后关隧道 | 停止远端 web |
| `idle` | 关隧道，N 分钟后停止远端 | 保留（按 keep 处理） |

## 7. 安全

- 远端界面只绑 `127.0.0.1`，经 SSH 隧道访问；本地 HTTP API 只挂在本机 DSH Web 服务上。
- 本地 API：`x-dsh-remote-go: 1` 头 + Origin 同源 + 拒绝 `sec-fetch-site: cross-site`；`/events` 只做 Origin 栅栏。
- 密码只在连接请求里出现一次；勾选保存时写 DSH 凭据存储，不写 `hosts.json`。launch token 默认只在内存。
- 诊断导出统一脱敏（token / 密码 / 私钥 / 家目录）。
- 桌面 guest 自己管理 cookie、下载与权限；插件不读取 guest 内容，只注入主机条与推送状态。

## 8. 失败与恢复

| 场景 | 表现 |
|---|---|
| 网络不可达 / 认证失败 | `network` / `auth`，可重试 |
| 指纹变化 / 未知 | `host-key-changed` / `host-key-unknown` |
| 远端装不上托管 Node / npx 失败 | `remote-dsh-missing` / `remote-dsh-start-failed` |
| 远端已有手工 DSH | 暂停为 `conflict-pending`；取消时 `remote-dsh-running` |
| 版本不一致 | `version-mismatch` |
| 隧道或界面校验失败 | `remote-ui-unreachable` |
| 非 Linux | `unsupported-os` |

失败后状态与错误都通过 `/state` 与 SSE 推给客户端；重试从干净状态重新走管线。

## 9. 验收

1. 在干净 profile 安装插件，设置页出现「远程主机」，可添加并连接一台真实或模拟远端。
2. 首次连接完成指纹确认、托管 Node 准备、npx 预检、隧道与界面校验；主机卡片显示版本与状态。
3. 点「打开」后远端界面铺满窗口，主机条出现在远端侧边栏顶部，可切换主机、刷新、离开。
4. 断线后按设置自动重连；手动断开/关闭本地不误杀远端任务（按策略）。
5. 诊断导出包含 9 项检查且已脱敏；中英文界面均可完整操作。

## 10. 关键决策

- **整窗 guest，而非 iframe/反代**：行为最接近真实浏览器，且不需要代理远端 UI 字节。
- **本地 HTTP + SSE，而非远程 RPC**：端点少、无生成步骤、易测试。
- **ssh2，而非系统 ssh**：需要程序化主机指纹、一次性密码认证与 `forwardOut`。
- **插件托管 Node + npx 固定版本**：不依赖远端环境、版本一致、无需在远端分发插件。
- **本地不复制远端能力**：插件/凭据/设置都在远端界面里操作。
