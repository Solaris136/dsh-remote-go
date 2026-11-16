# dsh-remote-go 设计
> 本文描述**当前实现的产品设计**：目标、职责边界、界面、连接生命周期、远端运行时与安全。
> 代码结构见 [implementation.md](implementation.md)，协议见 [api.md](api.md)。

## 1. 目标
在本地 DSH 里，用一条 SSH 连接打开**服务器上原版 DSH 的完整界面**，像 VS Code Remote-SSH 一样工作：

- 主机在本地统一管理（增删改、连接、诊断），不需要在远端安装本插件。
- 远端界面在本地窗口里**整窗呈现**，本地不复制远端业务数据、不改写远端页面：桌面端用 Chromium guest，
  浏览器端用同源 iframe + 一条只转发该主机隧道字节的本地反向代理。
- 远端数据就是该用户自己的 `~/.dsh`：凭据、会话、工作区与直接在远端使用 DSH 完全一致。
- 远端运行时只有一条路径：**插件托管的 Node + `npx`**，DSH 版本与本机**精确一致**；不依赖、不修改系统 Node。

## 2. 非目标
- 不做插件自己的独立窗口、沉浸模式、本机通知、多窗口分屏（用户点远端界面里的外链时，由**顶层标签页**打开那一个链接，见 §4.8）。
- 不做通用反代：浏览器端的同源代理只服务**已连接主机自己的回环隧道**，不代理任意 URL、不缓存、不改写业务内容。
- 不接管远端插件、远端设置或远端凭据（这些在远端界面里操作）；本插件**不写远端 `~/.dsh`**。
- 不复制会话、工作区、附件与缓存，不做远端 → 本地的数据迁移；不迁移旧版的隔离运行时目录。

## 3. 职责边界
| 能力 | 本地（本插件） | 远端（原版 DSH） |
|---|---|---|
| 主机清单 / 向导 / 诊断 | ✅ | — |
| SSH 认证、主机指纹、跳板机 | ✅ | — |
| 启动 / 收养 / 停止远端 `dsh web`；本地回环隧道 | ✅ | — |
| 远端文件/文件夹下载（用户从文件树右键选择） | ✅ 经 SSH/SFTP 读取；文件流式、文件夹逐个文件写入用户选择的本地目录；保存位置由用户选择 | 文件树与右键菜单、右下角进度卡 |
| 界面呈现 | 提供承载与主机条：桌面端 Chromium guest / 浏览器端同源 iframe + 代理 | 渲染完整 DSH Web UI |
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
载体的选择只取决于当前页面：有桌面桥（Electron 壳）时用 Chromium guest；没有时（浏览器里的 `dsh web`）用
**同源 iframe + 本地反向代理**。两者共享同一个窗口池、主机条、热窗口与断开语义，只有“页面怎么被嵌进来”不同。

**桌面端（Chromium guest）**：

1. 用 `GET /hosts/:id/open` 取一次性 token 的本地回环 URL 并校验 `http://127.0.0.1:` 前缀；URL 与主机绑定，只会交给它自己的窗口。
2. 经桌面桥 `window.dshDesktop.browser.acquire` 取 guest lease，创建 Chromium guest（`<webview>`）**铺满整个窗口**。guest 是 Web 构建、没有 preload，每次加载后都要注入桌面窗口标记（`<html data-windows-titlebar>` + `--dsh-windows-titlebar-height`，高度读本地页面；全屏标记 `data-fullscreen`）：页面自己让出标题栏那一条，两边才是**同一套栅格**（侧边栏行高、入口页留白、居中浮层与 `position:fixed` 元素对齐；不注入时差 10–40px）。注入失败或窗口本没有这条带（macOS、Web 构建）时退回「guest 整体下移一条」——**任何时候都只有一条标题栏**。
3. guest 盖住标题栏那一条后，拖拽与本地菜单要补回来：carrier 在标题栏区域放一条 `-webkit-app-region: drag` 拖拽条（guest 自己固定控件只占左侧 84px），并在 `<html>` 上加 `drg-caption-live` 把宿主标题栏菜单抬到 guest 之上；回本地页时一起撤掉。
4. guest 每次 `did-stop-loading` 后，先补标题栏标记，再注入同一条主机条脚本；列表与状态经 `update(<payload>)` 推送，点击经 `window.__drgBridgeQueue` 队列轮询取回。顺序不能反（主机条按桌面栅格量到的品牌行定位）。

**浏览器端（同源 frame + 反向代理）**：浏览器没有 guest 能力，直接内嵌回环地址又会变成跨源页面（本地 cookie
会被远端覆盖，HTTPS 页面还会被混合内容拦截），所以由 Host 侧在本机 DSH 的 Web 服务上挂一条只在
`/dsh-remote-go/remote/<hostId>/` 下生效的反向代理：

1. `GET /hosts/:id/open` 除回环 `url` 外还返回同源 `webUrl`；客户端校验它必须是 `/dsh-remote-go/remote/<hostId>/`
   形状的相对路径，再交给 iframe。
2. 代理去掉前缀后转发到该主机**当前**隧道的同一路径（query 原样），把 `Host`/`Origin` 改写为远端自己的回环
   authority，远端 authority 绑定的 cookie 与同源栅栏因此继续成立；响应里的 `Set-Cookie` 被收进 Host 侧的
   per-host cookie jar，浏览器只拿页面，不拿远端 cookie，本地与远端在 `127.0.0.1` 上互不干扰。
3. 远端唯一的 WebSocket（`/api/remote.mux`）按主机注册一条精确升级路由；升级请求同样从 jar 注入 cookie。
4. iframe 每完成一次导航，客户端就往它的 `contentWindow` 注入同一条主机条与远端文件桥：同源使它们可以
   像普通对象一样直接调用，不需要 `executeJavaScript`，也不依赖页面开 `unsafe-eval`。
5. 代理只服务 `connected` 主机、只接受同源请求；断开后 URL 立即失效，不存在“宿主列表里还有这台、隧道已经没了”
   的悬空窗口。

**远端窗口保持热态**：每台主机一个载体（桌面 guest 用独立 partition，浏览器 iframe 用自己的文档），
**不设数量上限**；切走只隐藏、不销毁，所以「本地 → 那台远端」「远端 A → 远端 B → 远端 A」都不重新加载。
断开、删除或插件卸载时才释放载体。加载失败过的窗口下次显示时重载一次；建窗期间用户改点别处，建好的窗口
不抢窗口。回本地只关窗口显示，不断 SSH、不停远端任务。

**切过去的第一帧**：被隐藏的 `<webview>` 没有可用的 guest surface，直接显示会先画出 carrier 自己的底色——热窗口一帧，冷窗口是整个页面加载期。这就是「本地 → 远端会闪一下、远端 → 本地不会」的原因（反向只是瞬间露出已经画好的本地页面）。所以显示分两步：carrier 先透明挂上（`opacity:0`，同时 `pointer-events:none`，这期间窗口仍是本地页、仍可点），等 guest 提交文档并真的画出帧（两帧 `requestAnimationFrame`，冷窗口等文档最多 1.2s、等绘制最多 0.32s 兜底），再一次性变为不透明；期间用户切去别处，这次显示作废，不会把窗口抢回来。

### 4.3 添加 / 编辑主机
只有一步：SSH 信息（地址 / 别名、端口、用户名、认证（私钥文件或密码）、跳板机），没有「连接测试」步骤，也就没有测试成功后的「完成」——连接只有两种结局：真的连上并接管整窗，或者根本没开始。

存活策略与主机指纹策略收在表单底部的折叠区「**高级选项**」里：默认收起，不打断主流程。

- **保存**：只落盘配置并关窗（弹出「已保存」提示），不发起连接；编辑模式只有这一个按钮。
- **连接**（仅添加模式）：保存后把连接交给连接窗口；密码认证时表单里填的密码直接用于这一次连接，不再问第二遍。

### 4.4 连接窗口（进度 + 连接日志）
点开一台尚未连接的主机（或向导里的「连接」）后，浮窗换成连接窗口，下半部分**不再显示主机清单**：

- 上半部分是分阶段进度（SSH → 探测 → 准备运行时 → 启动 → 隧道 → 校验界面）、指纹确认卡片，或失败时的错误卡片（可重试 / 诊断 / 返回）。
- 下半部分是**连接日志**：Host 在连接全程写下的逐行日志（SSH 目标、指纹、探测结果、托管 Node 下载 / 安装、npx 取包、远端 DSH 启动、隧道、校验、失败原因），等宽字体、按级别着色（debug 弱化，warn / error 用状态色），新行到达时自动滚到底部，用户往上翻则停止跟随。它来自 `HostView.logs`（[api.md](api.md)），经同一条 `/state` SSE 推送。
- **每次连接从干净的日志开始**：手动连接 / 重连 / 自动重连都会清空上一次的行与序号，先写一条带次数与时间的边界行（`— 第 N 次连接 · 时刻 —`），所以面板默认只有本次连接；每行还带写下它时所在的阶段（`phase`），面板在行首显示阶段标签，滚动时能看出停在哪一步。
- **失败时日志自己就能说明问题**：失败被写成多行 `error` 级日志，顺序是「失败阶段 + 错误码」→ 双语原因（与错误卡片同一句）→ 每一条建议 → 脱敏并 `headTail` 截断的技术细节；`remote-dsh-start-failed` 的技术细节是远端日志尾部，逐行打印。日志里的双语行由 Host 下发 `text: { zh, en }`，面板按当前语言渲染。
- 关窗不中断连接：连上后窗口自动闭合并接管整窗；失败时窗口留着，日志与错误一起可见。「返回」与主机条里的「管理界面」都回到主机清单。日志行本身不改写、不脱敏；脱敏只发生在**技术细节行**与**导出的诊断包**里。

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
- 远端窗口用远端主题，本地主题不影响它（整窗 guest / 同源 frame 的边界；注入到远端页面里的主机条读的是远端页面的 token）。标题栏那一条由远端页面自己绘制、用远端主题，叠在上面的宿主标题栏菜单仍是本地主题。
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

### 4.8 远端界面的浏览器能力（能力桥）

浏览器载体的远端界面跑在**同源 iframe** 里：DOM 与 `localStorage` 共享，但「只有顶层文档才有」的能力不随之下沉。剪贴板写入在子文档里会被拒（`Document is not focused` / `Write permission denied`），`window.open` 没有处理者，链接点击后前端既不开侧栏也不开新标签——用户看到的就是「复制没反应」「链接点不动」。`allow` 属性只能收窄、不能扩权，也不解决焦点要求，所以修复点在**能力桥**（`client.js` 的 `mountCapabilityBridge`），`allow` 只是补强。

**协议**：frame 内注入的脚本把需要顶层能力的行为转成 intent，走主机条/下载桥同一条通道（`__drgBridgeSink` 直接调用，或桌面 guest 的 `__drgBridgeQueue` 轮询）：

| intent | 触发 | 顶层执行 | 回执 |
|---|---|---|---|
| `open-external` | 捕获阶段拦 `a[href]`（解析后跨 origin、绝对 http(s)、无凭据）；`window.open(http(s))` | `externalUrlOf` 再收窄 → `win.open(url,'_blank','noopener,noreferrer')`；只有 URL 不是 http(s) 时弹 toast | 无（同步动作） |
| `clipboard-write` | 覆写 frame 的 `navigator.clipboard.writeText` | 本页 `copyText`：`writeText` → 失败仍走 `execCommand('copy')` | `{ id, ok }` 经 `__drgCapabilityReply`（浏览器载体是直接返回的 promise）；frame 收到失败先用自己的 `execCommand` 兜底，再失败才 reject 并发 `notify` |
| `notify` | 桥自己无法告知用户的失败（目前是剪贴板） | 复用浮层 toast（`toolStore.requestNotice`），`code` 由本页本地化 | 无 |

- **链接**：只拦 `http(s)` 且**跨 origin**；同源链接、`download` 属性、以及插件自己注入的下载项（`data-drg-dir-download`）一律放行。**修饰键 / 非主键点击不动**（`button !== 0`、`ctrl/meta/shift/alt`）：那是用户要浏览器的默认语义（后台标签、新窗口、中键），桥不接管，与 chat 视图自带的 `openExternalLink` 守卫一致。普通左键点击会把手势激活传到父文档（**仅浏览器载体**；桌面 guest 是另一个 WebContents，不传递），所以顶层 `window.open` 拿得到浏览器要的手势。`noopener,noreferrer` 是硬约束（打开的站点既不能摸到本页 `window.opener`，Referer 也不能带上本页 URL——它含本地 launch token），代价是**成功打开也返回 `null`**，所以弹窗拦截无法可靠判定：桥不猜，也就不对被拦弹窗报错。行为变更：桥在捕获阶段接走点击，前端 `linkOpening='sidebar'` 设置对它覆盖的这类链接不再生效（issue #64 期望的正是「顶层开」而不是「远端页里再嵌一层」）。
- **`allow=popups` 的边界**：`popups` 是登录 `about:blank` 骨架与「新标签打开」的必需项，但它同时让 frame 获得**原生开窗**能力——远端页面自己的 `a[target=_blank]`（或 `window.open` 走原生分支）可以打开任意 URL，**完全不经过**桥与 `externalUrlOf`。所以 URL 白名单是 **UX / 一致性护栏，不是对远端页面的隔离边界**；真正的边界是「远端页面本身可信」——它是用户自己连的那台主机的 DSH，本来就能渲染整窗、经同一通道切换/断开主机。桥要挡的是**意外**（前端在 frame 里开空白嵌套页、复制静默失败），不是防住这台主机。
- **剪贴板**：写入**只在顶层文档发生**；桥从不代读剪贴板（不碰 `readText`/`read`），也没有把任意页面文本暴露给远端页面的路径。两处如实说明：frame 的 `allow` 仍带基线就有的 `clipboard-read`（桥不代读，页面能否原生 `readText` 取决于浏览器权限与焦点）；`clipboard-write` 不校验 `userActivation`，只要本地页聚焦，远端页即可**无手势**覆写剪贴板——这是桥主动授予的能力（frame 之前没有），依据同样是「远端页=用户自己的 DSH」。
- **登录弹窗**：iframe 现在声明 `popups`，账号登录的 `window.open('about:blank')` 骨架仍交给浏览器（桥只接管有 URL 的 http(s) 目标），所以空白弹窗能开、后续导航由页面自己完成；OAuth 回调能否走通仍取决于远端页面自己的流程，插件不承诺。
- **语音输入**：`allow` 补上 `microphone`；麦克风授权仍由远端页面自己请求、由用户在该站点上授权，插件不代授权、也无法把授权结果搬到顶层。
- **提示（notify）**：已知 `code`（目前 `clipboard-failed`）映射到本页文案；**自由文本一律带「远端界面：」来源前缀**，让它不可能读起来像本地 chrome 的提示——信任前提仍是「远端页面可信」，前缀只是避免伪装成本地界面。
- **存储分区**：远端页面与本地页面同源，偏好类配置（快捷键、终端偏好、会话宽度）默认会互相覆盖。`mountGuestStorage` 在加载后把 frame 的 `localStorage` 换成按 `drg:<hostId>:` 分区的 Storage 视图：远端写不进本地键，本地也改不动远端值。**边界**（已知限制，不是安全问题）：
  - 注入发生在 frame 的 `load`，页面**启动时**读到的值仍来自未分区的那一份——远端界面重载后会先用共享值启动一次，从注入之后的读写才走自己的命名空间。所以被隔离的是「远端写 → 本地读」与「本地写 → 远端读」的实时/后续路径，不包括远端页面自己的启动读取；要连启动读取也隔离，得在 host 半端注入（改写被代理的 HTML）或把偏好改走宿主/服务端存储，这两条都不在本 PR 内。
  - 只代理 `localStorage` 的常用接口；`sessionStorage`、cookie、IndexedDB 不受影响。页面若在注入前缓存了原始 `Storage` 引用（或走 `Storage.prototype`），仍可绕过——这是**数据卫生**，不是安全边界。
  - `storage` 事件只在注入之后注册的监听器上被过滤（页面自启动就装上的监听器已经先跑过了）；持久化本身已经隔离，所以最多是一次「即时跟随」，不会留下串改后的值。
- **桌面载体**：guest 有自己的分区，但 `<webview>` 的 `window-open` 处理在 DSH 桌面主进程里（`shell.openExternal` 也只有那边能调），插件客户端半端装不上 `setWindowOpenHandler`。桌面路径因此复用同一条桥：guest 里的链接/`window.open` 经队列回到本地页面，由该页面打开。**边界**：桌面壳若不让渲染进程开新窗口，链接就只是被丢掉（`noopener` 让返回值无法区分「打开了」和「被拦了」，桥不猜）；这一路的需求侧修复是 DSH 桌面桥暴露一个 `openExternal(url)`，属于后续工作，本 PR 没有假装覆盖。
- **不在本仓库**：前端 bundle 里的 `writeClipboard`（reject 后不回退、失败不提示）与 `openExternalLink`（在 frame 内自开侧栏/`window.open`）无法在插件里改。桥在**调用点**上等效修好了它们：`writeText` 现在总是成功或可见失败，外链总是在顶层打开；但前端自己仍可能选择「侧栏 browser」分支（那是 DSH 的设置），那个嵌套页面不是本插件能改的。

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
- 远端界面只绑 `127.0.0.1`，经 SSH 隧道访问；本地 HTTP API 与同源代理只挂在本机 DSH Web 服务上。
- 本地 API：`x-dsh-remote-go: 1` 头 + Origin 同源 + 拒绝 `sec-fetch-site: cross-site`；`/events` 只做 Origin 栅栏。
  同源代理使用同一栅栏（iframe 导航与 WebSocket 无法加自定义头）。
- 同源代理只服务**已连接主机**：未知 / 未连接 id 直接 404，不建立上游连接；不代理调用方给出的任意 URL。
- 远端 session cookie 只存在 Host 侧 per-host jar，浏览器拿不到；本地 DSH 的 cookie 也永不转发给远端。
  转发时 `Host`/`Origin` 改写为远端 listener 的 authority，远端的同源与 cookie 校验仍成立。
- 密码只在连接请求里出现一次；勾选保存时写 DSH 凭据存储，不写 `hosts.json`。launch token 默认只在内存，
  只出现在首次导航的 `url` / `webUrl` 里。
- 诊断导出统一脱敏（token / 密码 / 私钥 / 家目录）；桌面 guest 自己管理 cookie、下载与权限，插件不读取 guest 内容，
  只注入主机条与推送状态。
- 能力桥的授权面与它的能力一样窄：跨进/跨出 frame 的只有「用户点的那个 http(s) 链接」「要写进剪贴板的文本」「一条提示」。
  链接先经 `externalUrlOf` 收窄（http/https、必须有主机、不带凭据、≤8KB），再交给浏览器；顶层 `window.open` 用
  `noopener,noreferrer`（打开的站点既拿不到 `window.opener`，Referer 也不含本页 URL），因此无法从返回值判断弹窗是否被拦，
  桥不重试、不换通道，也不对被拦弹窗报错。桥**不提供读剪贴板**，也不把本地
  页面的任何状态交给 frame。**这些护栏不是对远端页面的隔离边界**：frame 的 `allow=popups` 让远端页面自己的
  `a[target=_blank]` 可以原生开任意 URL，绕开桥与 `externalUrlOf`；`clipboard-write` 也不校验手势，远端页可以在本地页
  聚焦时静默覆写剪贴板。两者都建立在「frame 里的页面 = 用户自己连的那台远端 DSH」这一信任前提上：它本来就能渲染整窗、
  也能通过同一通道切换/断开主机，桥只是把它需要的浏览器能力搬到有权限的文档里执行，不宣称把它关进沙箱。
  `localStorage` 分区是数据卫生（防止偏好互相覆盖），不是同源隔离的安全边界。

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
3. 桌面端：点某台主机后远端界面铺满窗口，本地与远端侧边栏顶部都有主机条；浏览器端：同一操作让远端界面进入
   同源 iframe，主机条同样出现在远端侧边栏顶部。两端都支持点「本地」回来、点另一台切过去。
4. 断线后按设置自动重连；手动断开 / 关闭本地不误杀远端任务（按策略）；诊断导出包含 10 项检查且已脱敏；中英文界面均可完整操作。
5. 浏览器端在远端界面里：代码块/工具输出的「复制」真的写入剪贴板（失败有提示），点消息里的 `https://` 链接在顶层标签页打开
   （页面不会被导航走、也不出现空白嵌套页），远端与本地改偏好互不影响；麦克风与登录弹窗所需的 `allow` 已声明。

## 10. 关键决策
- **桌面端整窗 guest，浏览器端同源 frame + 受控代理**：桌面 guest 行为最接近真实浏览器且不需要代理字节；
  浏览器没有 guest 席位，跨源 iframe 会混用 `127.0.0.1` 的 cookie（且 HTTPS 下被混合内容拦截），
  所以用一条只服务已连接主机隧道的同源代理换取 cookie 隔离与主机条注入能力。
- **能力用 intent 桥，而不是扩大 iframe 权限**：`allow` 只能收窄、不能扩权，剪贴板还要求顶层焦点；把「链接/剪贴板/提示」
  变成顶层执行的 intent，既能覆盖前端 bundle 里改不到的实现，也不给 frame 额外的浏览器权限。
- **本地 HTTP + SSE，而非远程 RPC**：端点少、无生成步骤、易测试。
- **ssh2，而非系统 ssh**：需要程序化主机指纹、一次性密码认证与 `forwardOut`。
- **插件托管 Node + npx 固定版本**：不依赖远端环境、版本一致、无需在远端分发插件。
- **本地不复制远端能力**：插件 / 配置 / 凭据 / 设置仍在远端界面里操作；本地只负责连接与呈现。
