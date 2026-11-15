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
- 不做本地反代、iframe 内嵌或第二个浏览器窗口；不做沉浸模式、本机通知、多窗口分屏。
- 不接管远端插件、远端设置或远端凭据（这些在远端界面里操作）；本插件**不写远端 `~/.dsh`**。
- 不复制会话、工作区、附件与缓存，不做远端 → 本地的数据迁移；不迁移旧版的隔离运行时目录。

## 3. 职责边界
| 能力 | 本地（本插件） | 远端（原版 DSH） |
|---|---|---|
| 主机清单 / 向导 / 诊断 | ✅ | — |
| SSH 认证、主机指纹、跳板机 | ✅ | — |
| 启动 / 收养 / 停止远端 `dsh web`；本地回环隧道 | ✅ | — |
| 远端文件/文件夹下载（用户从文件树右键选择） | ✅ 经 SSH/SFTP 读取；文件流式、文件夹逐个文件写入用户选择的本地目录；保存位置由用户选择 | 文件树与右键菜单、右下角进度卡 |
| 界面呈现 | 提供承载与主机条 | 渲染完整 DSH Web UI |
| 数据（会话、工作区、凭据） | 只读版本/诊断信息 | ✅ 用户自己的 `~/.dsh` |

本地只持有**连接状态**与**一次性 launch token**；远端界面、业务数据与会话内容都不经过本地 HTTP API。

## 4. 界面
### 4.1 主机条（主机入口）
插件**不在设置面板注册任何页面**（没有 `settings.section`），也不注册侧边栏全局面板行（`sidebar.panellist`）或 `main` 主面板：主机条是管理主机的唯一入口，避免同一份管理界面出现两次；设置面板只保留 DSH 自己的页面。

侧边栏顶部（品牌行下一行）有一条主机条，**本地页面和远端页面里各有一份**，由同一段脚本绘制：

- 收起时只显示当前目标：状态点 + 名字（本地时是「本地」）+ 折角，没有第二行标题；侧边栏收起成窄条时隐藏。点开是列表：「本地」→ 每台远端主机（右侧带地址）→「添加主机」「管理界面」。
- 状态点即可用性：**已连接是绿色发光点**（点它就能切过去）；未连接 / 断线是灰点；连接中、待确认指纹、冲突、失败各有自己的颜色。
- 点「本地」回本地页面；点某台主机切到那台（未连接时先浮出主机清单、在那里连接，连上自动接管）；每台主机的「打开」与它等价。
- 已连接主机行右侧有「断开」，**鼠标移到该行才显示**：断开这台（并释放它的窗口），不会切过去。断的是当前这台，窗口回本地、主机条也回「本地」；断的是别的热窗口，主机条不动。
- 「添加主机」与「管理界面」都是浮窗（`shell.overlay`）：浮在当前页面之上，远端开着时背景仍是远端，关掉回原来那一页。管理清单里是编辑 / 诊断 / 删除 / 重连；正在连接的那台**不进清单**——它有独立的连接窗口（§4.4）。密码与远端冲突按需弹窗。
- 没有单独的「刷新远端界面」：要重载用清单里的「重连」（重建窗口）；点同一台只是重新显示热窗口，不重新加载。

主机条是页面 DOM 的一部分（用页面自己的主题变量绘制），继承该页面的字体、hover 与弹层遮罩，并带很高的 `z-index`，所以页面自己的模态遮罩弹出时也能点。数据只有一次常驻的 `/state` 订阅（在浮层宿主里），主机条、浮窗与远端窗口都读它；命令走两条一次性通道：`panelStore`（open / disconnect / manage / local）与 `wizardStore`（add / edit 草稿）。

### 4.2 整窗接管与切换开销
点某台主机后，客户端：

1. 用 `GET /hosts/:id/open` 取一次性 token 的本地回环 URL 并校验 `http://127.0.0.1:` 前缀；URL 与主机绑定，只会交给它自己的窗口。
2. 经桌面桥 `window.dshDesktop.browser.acquire` 取 guest lease，创建 Chromium guest（`<webview>`）**铺满整个窗口**。guest 是 Web 构建、没有 preload，每次加载后都要注入桌面窗口标记（`<html data-windows-titlebar>` + `--dsh-windows-titlebar-height`，高度读本地页面；全屏标记 `data-fullscreen`）：页面自己让出标题栏那一条，两边才是**同一套栅格**（侧边栏行高、入口页留白、居中浮层与 `position:fixed` 元素对齐；不注入时差 10–40px）。注入失败或窗口本没有这条带（macOS、Web 构建）时退回「guest 整体下移一条」——**任何时候都只有一条标题栏**。
3. guest 盖住标题栏那一条后，拖拽与本地菜单要补回来：carrier 在标题栏区域放一条 `-webkit-app-region: drag` 拖拽条（guest 自己固定控件只占左侧 84px），并在 `<html>` 上加 `drg-caption-live` 把宿主标题栏菜单抬到 guest 之上；回本地页时一起撤掉。
4. guest 每次 `did-stop-loading` 后，先补标题栏标记，再注入同一条主机条脚本；列表与状态经 `update(<payload>)` 推送，点击经 `window.__drgBridgeQueue` 队列轮询取回。顺序不能反（主机条按桌面栅格量到的品牌行定位）。

**远端窗口保持热态**：每台主机一个 guest（独立 partition / cookie），**不设数量上限**；切走只隐藏、不销毁，所以「本地 → 那台远端」「远端 A → 远端 B → 远端 A」都不重新加载。断开、删除或插件卸载时才释放 guest 与 lease。加载失败过的窗口下次显示时重载一次；建窗期间用户改点别处，建好的窗口不抢窗口。回本地只关窗口显示，不断 SSH、不停远端任务。

**切过去的第一帧**：被隐藏的 `<webview>` 没有可用的 guest surface，直接显示会先画出 carrier 自己的底色——热窗口一帧，冷窗口是整个页面加载期。这就是「本地 → 远端会闪一下、远端 → 本地不会」的原因（反向只是瞬间露出已经画好的本地页面）。所以显示分两步：carrier 先透明挂上（`opacity:0`，同时 `pointer-events:none`，这期间窗口仍是本地页、仍可点），等 guest 提交文档并真的画出帧（两帧 `requestAnimationFrame`，冷窗口等文档最多 1.2s、等绘制最多 0.32s 兜底），再一次性变为不透明；期间用户切去别处，这次显示作废，不会把窗口抢回来。

### 4.3 添加 / 编辑主机
只有一步：SSH 信息（地址 / 别名、端口、用户名、认证（私钥文件或密码）、跳板机），没有「连接测试」步骤，也就没有测试成功后的「完成」——连接只有两种结局：真的连上并接管整窗，或者根本没开始。

存活策略与主机指纹策略收在表单底部的折叠区「**高级选项**」里：默认收起，不打断主流程。

- **保存**：只落盘配置并关窗（弹出「已保存」提示），不发起连接；编辑模式只有这一个按钮。
- **连接**（仅添加模式）：保存后把连接交给连接窗口；密码认证时表单里填的密码直接用于这一次连接，不再问第二遍。

### 4.4 连接窗口（进度 + 连接日志）
点开一台尚未连接的主机（或向导里的「连接」）后，浮窗换成连接窗口，下半部分**不再显示主机清单**：

- 上半部分是分阶段进度（SSH → 探测 → 准备运行时 → 启动 → 隧道 → 校验界面）、指纹确认卡片，或失败时的错误卡片（可重试 / 诊断 / 返回）。
- 下半部分是**连接日志**：Host 在连接全程写下的逐行日志（SSH 目标、指纹、探测结果、托管 Node 下载 / 安装、npx 取包、远端 DSH 启动、隧道、校验、失败原因），原样打印、等宽字体、按级别着色（debug 弱化，warn / error 用状态色），新行到达时自动滚到底部，用户往上翻则停止跟随。它来自 `HostView.logs`（[api.md](api.md)），经同一条 `/state` SSE 推送。
- 关窗不中断连接：连上后窗口自动闭合并接管整窗；失败时窗口留着，日志与错误一起可见。「返回」与主机条里的「管理界面」都回到主机清单。日志是用户本机产生的内容，插件不加前缀、不改写、不脱敏；脱敏只发生在**导出的诊断包**里。

### 4.5 诊断与设置
- 诊断抽屉：10 项固定检查（SSH 可达性、认证、主机指纹、隧道、远端服务、远端界面、远端 Node、版本、模型凭据、桌面守卫），支持复制脱敏报告。
- 设置弹窗：管理清单右上角的齿轮打开，含 SSH 默认值、自动重连、指纹策略、保存令牌开关、界面语言、日志级别、远端 `profile`。
- 密码按需弹窗；指纹确认与远端冲突各有 120s 超时兜底（超时分别按拒绝 / 取消处理）。

### 4.6 视觉与主题兼容
插件不拥有配色，只消费宿主主题：所有颜色、圆角、阴影、字体与滚动条都直接使用 `--dsw-*` 别名，**没有本地 token 层**——不声明 `--drg-*`，也不写 `:root`；浮层座位继承 `body`/祖先的主题变量，插件不缓存颜色、不判断亮暗、没有 `prefers-color-scheme` 分支，也不在 JS 里算颜色。

- 表面沿用宿主自己的组件语义：对话框 `--dsw-alias-bg-layer-2` + `--dsw-radius-panel` + `--dsw-elevation-prominent`；下拉菜单 `--dsw-specific-menu` + `--dsw-menu-backdrop-filter` + `--dsw-elevation-panel`；遮罩 `--dsw-alias-bg-mask-1` + `--dsw-mask-blur`；输入框 `--dsw-alias-bg-layer-3` + `.5px --dsw-alias-border-l4`。
- 三种主题来源都即时生效：内置 light/dark；其他插件 `ctx.theme.register()` 后 `setTheme()`；`ctx.theme.overrideTokens()` 的 token 覆盖层。`ThemePresenter` 把合成后的 token 写成 `body` 内联变量，界面在下一次绘制时就跟随，无需重载。
- 主题未提供的 token 不会被「补」成自有颜色：`client.js` 里没有任何颜色字面量（hex / `rgb()` / `hsl()`）；token 改名或缺失会让 `guards.test.js` 的 `client-styles` 守卫与 E2E 失败，而不是悄悄落回仿配色。只有圆角与字体栈保留通用缺省；第三方插件只在局部容器改 token 时，浮层保持基础调色板。
- 主按钮成对使用 `--dsw-alias-button-primary-fill` 与 `--dsw-alias-label-primary-foreground`，状态色用 `--dsw-alias-state-*-primary`；**对比度由主题负责**，插件不替主题纠正颜色。
- 远端窗口用远端主题，本地主题不影响它（整窗 guest 的边界）；标题栏那一条由远端页面自己绘制、用远端主题，叠在上面的宿主标题栏菜单仍是本地主题。
- 可访问性：焦点环走 `--dsw-focus-ring-*`；尊重 `prefers-reduced-motion`、`prefers-contrast: more` 与 `forced-colors: active`；窄窗口下主机清单变单列、向导 / 设置变全宽浮层。
- 验收：E2E 用「内联 token」模拟第三方主题，断言界面颜色跟随、按钮对比度达标、移除覆盖层后恢复宿主调色板；单元测试锁定 token 白名单（未知 token 直接失败）、禁止 `--drg-*` 自有 token、禁止颜色字面量、禁止渐变与配色模式分支。

### 4.7 远端文件与文件夹下载
终端入口不再由插件提供：DSH 自带的开始页「新建终端」卡片（含 Shell 选择菜单）和 `Ctrl+\`` 快捷键在本地与远端页面里都已经存在，插件不再重复实现按钮、Shell 类型设置或终端快捷键。

**下载**覆盖文件和文件夹，并在本地显示进度条、让用户选择保存位置：

1. guest 注入脚本在 `li[data-files-entry][data-files-path]` 上记住被右键的**文件或目录**。文件菜单按下载图标（`dsw-icon-download-outline-regular`）识别 DSH 自带的「下载」项；目录菜单没有下载项，脚本在同一次右键后克隆一个菜单项并追加「下载到本地」。
2. 用户点它时，脚本在捕获阶段拦下页面自己的 Blob 下载（桌面 guest 会话会 `preventDefault` 掉 Chromium 下载），把 `{ action:'download-file', kind, path, name }` 放进既有 bridge 队列；随后隐藏这次菜单（下一次右键时恢复）。
3. 本地壳体从队列取出意图，让用户用 DSH 自己的目录选择器选一个本机目录，再 `POST /downloads` 创建 Host 侧任务。Host 用同一条 SSH/SFTP 连接判断路径并**流式写入磁盘**：
   - 普通文件：写入 `<目录>/<远端文件名>`；同名文件已存在时自动改用 `<名字> (2).<扩展名>`、`<名字> (3).<扩展名>`……，不设置大小上限；
   - 文件夹：在所选目录下新建 `<远端文件夹名>`，同名文件夹**或文件**已存在时自动改用 `<名字> (2)`、`<名字> (3)`……；递归枚举（跳过符号链接）后逐个文件写入，保留子目录与空目录，**不打包 ZIP**，也不限制文件大小、总字节或条目数。
4. 任务进度通过 SSE `download` 事件推送，客户端同时以 `/downloads/:id/status` 轮询兜底。右下角的下载卡是**可拖动**的悬浮层（卡片标题栏即拖动柄，位置限制在视口内，不改变布局），显示确定进度条（准备阶段显示 indeterminate）；准备阶段有「取消下载」按钮，错误/完成卡片有关闭按钮。任务 `ready` 表示文件/文件夹已经写在本机，客户端只提示最终路径，不再取回 Blob、不弹另存为对话框。取消会销毁当前流并清理由本次任务创建的未完成文件/目录。
5. 远端路径只在用户实际点了下载时才被使用；guest 永远拿不到本地文件系统。Host 不提供目录浏览接口，也不写远端磁盘。

## 5. 连接生命周期
### 5.1 状态、阶段与进度
| status | 含义 |
|---|---|
| `unconfigured` / `disconnected` / `error` | 尚未连接过 / 断线可重连 / 连接、认证或服务失败 |
| `connecting` / `fingerprint-pending` / `conflict-pending` | 连接中（配合 phase / progress）/ 等待确认主机指纹 / 远端已有手工启动的 DSH，等待用户选择 |
| `connected` | 远端界面可用 |
| `limited` | 保留状态：能连但远端无法提供界面 |

`phase` 取值：`ssh` → `probe` → `bootstrap` → `start` → `tunnel` → `verifying` → `ready`。进度码是细粒度、可本地化的 `{ code, params }`，具体列表以 [api.md](api.md) 为准；客户端只按 code 查文案，不推断连接逻辑。

### 5.2 连接流程
```text
connect(id)：解析目标 address → ~/.ssh/config 别名 → host/user/port/identityFiles；known_hosts 指纹集合
  ├─ [ssh]     ssh2 连接（指纹策略见 §5.3；跳板机先连跳板再 forwardOut 到目标 22）
  ├─ [probe]   远端探测：OS / Node / npm / npx / curl / 磁盘 / 凭据 / SSH 会话标记
  ├─ [bootstrap] 托管 Node：按本机 DSH engines.node 下限安装/复用 ~/.dsh/remote-go/node/v<version>
  ├─ [start]   收养上次留下的远端 web（run registry 的 dshHome/profile 匹配 + pid 存活 + 日志 URL）；未收养时扫描同一 ~/.dsh 下其他 DSH 进程，命中则暂停为 conflict-pending
  ├─ [bootstrap] npx 预检：npx -y @deepseek-ai/dsh@<本机版本> --version，回读必须相等（收养成功则跳过）
  ├─ [start]   启动：env DSH_HOME=~/.dsh PATH=<managed node bin> npx ... --profile <profile> --no-open --port 0
  ├─ [tunnel]  net.Server(127.0.0.1:0) → 每连接 ssh.forwardOut(127.0.0.1:remotePort)
  ├─ [verifying] 远端 curl 探活 + 经隧道完成 token→cookie→干净首页 校验
  └─ connected：记录 lastOpenedAt、activeHostId；按设置保存 token（默认不保存）
```

任一步失败都会落入分类错误（见 [api.md](api.md) 的 `ErrorView.code`），并执行同样的 teardown：关隧道、按策略决定是否停远端、清理状态。

### 5.3 主机指纹
- ssh2 `hostVerifier` 内计算 OpenSSH 形式的 `SHA256:<base64>`。
- 已记录指纹：匹配放行；变化 → `host-key-changed` 阻塞。未记录且 known_hosts 有该主机条目：任意一条匹配即放行（等价 OpenSSH），无匹配 → `host-key-changed`。
- 首次使用且无记录：`fingerprint-pending`，等待 `POST /hosts/:id/fingerprint`；超时按拒绝处理。
- `strict` 策略直接拒绝未知指纹，不弹窗。

### 5.4 断线、重连与退出
- SSH 连接 `close` 且用户期望保持连接时：状态转 `disconnected`，按设置做指数退避重连（`autoReconnect.maxAttempts`）。
- 手动断开：关隧道；`keepAlive=stop` 同时停远端，`idle` 延迟停止，`keep` 保留远端。
- 删除主机：先取消重连 / 空闲计时器，再 teardown，最后删记录；远端按该主机的存活策略处理。
- 本地 DSH 退出：`shutdown()` 对每台主机执行同样的 teardown。

## 6. 远端运行时
### 6.1 托管 Node + npx
只有一条路径：插件把**自己的 Node** 装到 `~/.dsh/remote-go/node/v<version>`，再用它的 `npx -y @deepseek-ai/dsh@<本机版本>` 拉起 DSH。

- 版本 = 本机 DSH `engines.node` 的下限（当前 24.9.0），随 DSH 读取、固定复用，不追最新补丁。
- 官方 `nodejs.org/dist` 的 tarball，先校验 `SHASUMS256.txt` 的 SHA-256 再解压；官方源不可达时回退 npmmirror 的同一版本。
- 永不使用系统 Node、不需要 root；没有系统 Node 兜底，装不上就明确失败。安装 / 复用同一版本后清理旧版本；没有自举分级、没有离线包。

### 6.2 版本一致
- 本机版本来源：`DSH_VERSION` / `DSH_RUNTIME_VERSION` → `clientModules.graph().release.version` → `@deepseek-ai/dsh/package.json`。
- 目标版本**恒等于本机版本**；没有 override/target 设置。托管 Node 版本则由本机 DSH 的 `engines.node` 下限决定。
- 预检回读不一致 → `version-mismatch`，连接中止。收养旧进程前校验 run registry（`dshHome`、`profile`、版本）；版本不符且属于本插件时先停止再另起。

### 6.3 收养与冲突
- 收养：读插件状态目录的 `run/web.json`，要求 pid 存活、日志 URL 可解析、HTTP 可达。收养让本地重启后复用远端实例。
- 冲突：远端已有手工启动的 DSH 时，列出进程并让用户选 `stop` / `alongside` / `cancel`；`alongside` 会在主机卡片留下共享 `~/.dsh` 的 warning。

### 6.4 存活策略
| 策略 | 本地断开时 | 本地 DSH 退出时 |
|---|---|---|
| `keep`（默认） | 只关隧道，远端继续 | 保留远端进程 |
| `stop` | 停止远端 web 后关隧道 | 停止远端 web |
| `idle` | 关隧道，N 分钟后停止远端 | 保留（按 keep 处理） |

### 6.5 凭据与远端数据
连接只读取远端的版本、端口与运行状态；远端 `~/.dsh` 里的插件、配置、凭据与会话始终由远端自己维护，
本插件不写入、不删除。API key 需要在这台机器上使用时，由用户在远端界面里自行配置。

## 7. 安全
- 远端界面只绑 `127.0.0.1`，经 SSH 隧道访问；本地 HTTP API 只挂在本机 DSH Web 服务上。
- 本地 API：`x-dsh-remote-go: 1` 头 + Origin 同源 + 拒绝 `sec-fetch-site: cross-site`；`/events` 只做 Origin 栅栏。
- 密码只在连接请求里出现一次；勾选保存时写 DSH 凭据存储，不写 `hosts.json`。launch token 默认只在内存。
- 诊断导出统一脱敏（token / 密码 / 私钥 / 家目录）；桌面 guest 自己管理 cookie、下载与权限，插件不读取 guest 内容，只注入主机条与推送状态。

## 8. 失败与恢复
| 场景 | 表现 |
|---|---|
| 网络不可达 / 认证失败 | `network` / `auth`，可重试 |
| 指纹变化 / 未知 | `host-key-changed` / `host-key-unknown` |
| 远端装不上托管 Node / npx 失败 / 远端启动失败 | `remote-node-install-failed` / `remote-dsh-missing` / `remote-dsh-start-failed` |
| 远端已有手工 DSH | 暂停为 `conflict-pending`；取消时 `remote-dsh-running` |
| 版本不一致 / 隧道或界面校验失败 / 非 Linux | `version-mismatch` / `remote-ui-unreachable` / `unsupported-os` |

失败后状态与错误都通过 `/state` 与 SSE 推给客户端；重试从干净状态重新走管线。

## 9. 验收
1. 在干净 profile 安装插件，设置面板里**没有**插件的页面；侧边栏顶部出现主机条，可从「添加主机」或「管理界面」添加并连接一台真实或模拟远端。
2. 首次连接完成指纹确认、托管 Node 准备、npx 预检、隧道与界面校验；主机卡片显示版本与状态。
3. 点某台主机后远端界面铺满窗口，本地与远端侧边栏顶部都有主机条：点「本地」回来，点另一台切过去，「+ 添加主机」在列表最下面。
4. 断线后按设置自动重连；手动断开 / 关闭本地不误杀远端任务（按策略）；诊断导出包含 10 项检查且已脱敏；中英文界面均可完整操作。

## 10. 关键决策
- **整窗 guest，而非 iframe/反代**：行为最接近真实浏览器，且不需要代理远端 UI 字节。
- **本地 HTTP + SSE，而非远程 RPC**：端点少、无生成步骤、易测试。
- **ssh2，而非系统 ssh**：需要程序化主机指纹、一次性密码认证与 `forwardOut`。
- **插件托管 Node + npx 固定版本**：不依赖远端环境、版本一致、无需在远端分发插件。
- **本地不复制远端能力**：插件 / 配置 / 凭据 / 设置仍在远端界面里操作；本地只负责连接与呈现。
