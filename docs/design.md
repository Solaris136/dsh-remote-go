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
| AI 会话查看主机列表与连接状态（§4.9） | ✅ 一个只读工具（白名单投影） | — |
| 界面呈现 | 提供承载与主机条：桌面端 Chromium guest / 浏览器端同源 iframe + 代理 | 渲染完整 DSH Web UI |
| 数据（会话、工作区、凭据） | 只读版本/诊断信息 | ✅ 用户自己的 `~/.dsh` |

本地只持有**连接状态**与**一次性 launch token**；远端界面、业务数据与会话内容都不经过本地 HTTP API。

## 4. 界面
### 4.1 主机条（主机入口）
插件**不在设置面板注册任何页面**（没有 `settings.section`），也不注册侧边栏全局面板行（`sidebar.panellist`）或 `main` 主面板：主机条是管理主机的唯一入口，避免同一份管理界面出现两次；设置面板只保留 DSH 自己的页面。

侧边栏顶部（品牌行下一行）有一条主机条，**本地页面和远端页面里各有一份**，由同一段脚本绘制：

- 收起时只显示当前目标：状态点 + 名字（本地时是「本地」）+ 折角，没有第二行标题；侧边栏收起成窄条时隐藏。点开是列表：「本地」→ 每台远端主机（右侧带地址）→「添加主机」「管理界面」。**这是本地页面那份行的内容**；远端页面里的行只列「本地」与当前 carrier 主机（见本节最后一段），跨主机切换要先点「本地」。
- 状态点即可用性：**已连接是绿色发光点**（点它就能切过去）；未连接 / 断线是灰点；连接中、待确认指纹、冲突、失败各有自己的颜色。
- 点「本地」回本地页面；在本地页面点某台主机切到那台（未连接时先浮出主机清单、在那里连接，连上自动接管）；每台主机的「打开」与它等价。远端页面里的行没有其他主机项，只能回本地后再切。
- 已连接主机行右侧有「断开」，**鼠标移到该行才显示**：断开这台（并释放它的窗口），不会切过去。断的是当前这台，窗口回本地、主机条也回「本地」；断的是别的热窗口，主机条不动。
- 「添加主机」与「管理界面」都是浮窗（`shell.overlay`）：浮在当前页面之上，远端开着时背景仍是远端，关掉回原来那一页。管理清单里是编辑 / 诊断 / 删除 / 重连，已连接的卡片另有「重启」与「关闭」（见 §5.5、§5.7）；正在连接的那台**也留在清单里**：卡片直接给出阶段与进度，点卡片任意位置或「查看进度」都能重新打开它的连接窗口（§4.4），所以关掉连接窗口不会让进度和日志无处可看。重启与显式「关闭」同样是 `connecting`，卡片保留以便随时看到动作状态（§5.5、§5.7）。连接中禁用编辑/删除；删除一台 `connecting` 的主机需要二次确认（会中断连接）。密码与远端冲突按需弹窗。
- 卡片还会显示 Host 的 `warning`（如手工实例并存）与 `versionParity`（远端版本与本机不一致 / 无法确认）。这些提示同时出现在连接窗口里，不只在诊断抽屉里。
- 状态流断开时，主机清单页脚显示「实时连接已断开，正在轮询」与「重新连接」按钮；Client 在轮询期间继续补下载任务状态（§4.7）。
- 所有对话框共用一层「模态栈」：一个 document 级 Escape 监听只交给栈顶，栈顶才能 `aria-modal`，下层 `inert`；唯一例外是**栈顶对话框渲染在某一层内部**（「关闭」确认在管理窗口里）：那一层不置 `inert`，否则嵌套的确认框连自己都收不到点击，只由栈顶自己的遮罩挡住下层。打开时焦点进入对话框（破坏性确认落在「取消」上）、Tab 在内部循环、关闭后焦点回到触发元素，并在最上层打开期间锁住页面滚动。动作进行中的对话框不可关闭：Escape、遮罩、头部 × 与底部按钮一律忽略（× 同时 disabled），避免请求还在跑而界面已经消失。
- 状态流断开时进入 `polling` / `reconnecting`：横幅只在真正收到 `open` / 首帧后才消失；自动重建最多 8 次，之后停在轮询并保留手动「重新连接」（重置计数）。降级与恢复同时经宿主 toast 提示，因此在本地页面和远端载体里都看得见。
- 没有单独的「刷新远端界面」：要重载用清单里的「重连」（重建窗口）；点同一台只是重新显示热窗口，不重新加载。

主机条是页面 DOM 的一部分（用页面自己的主题变量绘制），继承该页面的字体、hover 与弹层遮罩，并带很高的 `z-index`，所以页面自己的模态遮罩弹出时也能点。**远端页面里的那份只投影「本地 + 本 carrier 主机」**：guest 不渲染其他主机的行，跨主机切换要先回本地；guest 的退出控件因此与 `sanitizeGuestIntent` 的 hostId 约束一致，伪造其他主机的 disconnect 会被拒绝而不是断掉当前窗口。数据只有一次常驻的 `/state` 订阅（在浮层宿主里），主机条、浮窗与远端窗口都读它；命令走两条一次性通道：`panelStore`（open / disconnect / manage / local）与 `wizardStore`（add / edit 草稿）。

### 4.2 整窗接管与切换开销
载体的选择只取决于当前页面：有桌面桥（Electron 壳）时用 Chromium guest；没有时（浏览器里的 `dsh web`）用
**同源 iframe + 本地反向代理**。两者共享同一个窗口池、主机条、热窗口与断开语义，只有“页面怎么被嵌进来”不同。

**桌面端（Chromium guest）**：

1. 用 `GET /hosts/:id/open` 取一次性 token 的本地回环 URL 并校验 `http://127.0.0.1:` 前缀；URL 与主机绑定，只会交给它自己的窗口。
2. 经桌面桥 `window.dshDesktop.browser.acquire` 取 guest lease，创建 Chromium guest（`<webview>`）**铺满整个窗口**。guest 是 Web 构建、没有 preload，每次加载后都要注入桌面窗口标记（`<html data-windows-titlebar>` + `--dsh-windows-titlebar-height`，高度读本地页面；全屏标记 `data-fullscreen`）：页面自己让出标题栏那一条，两边才是**同一套栅格**（侧边栏行高、入口页留白、居中浮层与 `position:fixed` 元素对齐；不注入时差 10–40px）。注入失败或窗口本没有这条带（macOS、Web 构建）时退回「guest 整体下移一条」——**任何时候都只有一条标题栏**。
3. guest 盖住标题栏那一条后，拖拽与本地菜单要补回来：carrier 在标题栏区域放一条 `-webkit-app-region: drag` 拖拽条（guest 自己固定控件只占左侧 84px），并在 `<html>` 上加 `drg-caption-live` 把宿主标题栏菜单抬到 guest 之上；回本地页时一起撤掉。
4. 标题栏菜单的位置由**当前画这条带的那一页**决定：壳的 preload 把「应用 / 编辑」挂在 `left: var(--dsh-windows-menu-start, 48px)`，DSH 自己的规则只在侧边栏折叠时把它抬到 84px。远端 rail 收起后，它自己的「新建会话」也固定在带上 48px（和本地一样），所以本地页必须跟着远端 rail 的状态走：guest 经同一条队列上报 `[data-sidebar-collapsed]` 与它自己解析出的 `--dsh-windows-menu-start`（装载时一次、之后每次变化一次），宿主把那个值（收起 84px / 展开 48px）写成 `<html>` 内联变量盖过 DSH 的规则，回本地页时删掉，规则重新归本地页。值是**读** guest 的解析结果而不是复刻数字，DSH 改数值时插件自动跟随；读不到（没有 `getComputedStyle`、取值为空或不像 inset）时退回本机常量 48 / 84px。否则收起后「新建会话」正好压在 48px 起的「应用」上（#63）。
5. guest 每次 `did-stop-loading` 后，先补标题栏标记，再问一次 rail 状态、注入同一条主机条脚本；列表与状态经 `update(<payload>)` 推送，点击经 `window.__drgBridgeQueue` 队列轮询取回（一次 `executeJavaScript` 原子取走并清空，读取与清空分开会让落在中间的 intent 被吞掉）。顺序不能反（主机条按桌面栅格量到的品牌行定位）。

**标题栏这条带的已知限制**（同一个回传通道的代价）：

- 折叠 / 展开后菜单最多**一个轮询周期（400ms）**才跟上：这期间仍会短暂重叠（就是 #63 截图里那一下），随后归位；导航重载期间同理，最坏要等「远端 SPA 渲染时间 + 一个轮询周期」。
- guest 侧的 MutationObserver 装不上、或宿主在 guest 里执行脚本失败时**不报错**，`--dsh-windows-menu-start` 就停在 48px（等于未修复的形态）；DSH 若改名 `[data-sidebar-collapsed]` / `--dsh-windows-menu-start`，同样静默退回 48px。集成测试直接跑真实远端 UI，DSH 升级会在这里暴露。


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

编辑表单直接读 `HostView.port` / `HostView.username`（明文端口与用户名，不是秘密），不再反解析 `addressMasked` 展示串：`user@fe80::1` 曾被读成端口 1，默认端口 2222 也曾被静默改成 22。`addressMasked` 只用于展示（端口 22 省略、IPv6 加方括号）。密码认证的主机在**没有改动认证方式**时保存不需要密码，字段会说明「连接时会自动使用已保存的密码」；`passwordSaved:true` 时 Client 先尝试不带头像密码连接，只有 Host 报 `auth` 失败才弹密码框（Host 启动时从凭据存储恢复 `passwordSaved`，DSH 重启后同样成立）。表单里的密码默认勾选「记住密码」：SSH 认证通过后写入 DSH 凭据存储，取消勾选则只用于本次连接并清除已有记录。前端校验与 Host 的夹取范围一致（端口 1–65535、连接超时 5–300 秒、idle 1–1440 分钟、重试 0–20 次 / 100–30000 ms、profile 不允许 `desktop`），错误落到具体字段（`aria-invalid` + 提示）并把焦点移到第一个错误字段，修正即清除。
只有一步：SSH 信息（地址 / 别名、端口、用户名、认证（私钥文件或密码）、跳板机），没有「连接测试」步骤，也就没有测试成功后的「完成」——连接只有两种结局：真的连上并接管整窗，或者根本没开始。

存活策略与主机指纹策略收在表单底部的折叠区「**高级选项**」里：默认收起，不打断主流程。

- **保存**：只落盘配置并关窗（弹出「已保存」提示），不发起连接；编辑模式只有这一个按钮。
- **连接**（仅添加模式）：保存后把连接交给连接窗口；密码认证时表单里填的密码直接用于这一次连接（SSH 认证通过后按「记住密码」写入凭据存储），不再问第二遍。「保存」不连接时也会通过 `POST /hosts/:id/password` 记住或清除密码。

### 4.4 连接窗口（进度 + 连接日志）
点开一台尚未连接的主机（或向导里的「连接」、主机卡片上的「重连」「重启」）后，浮窗换成连接窗口，下半部分**不再显示主机清单**：

- 上半部分是分阶段进度（SSH → 探测 → 准备运行时 → 启动 → 隧道 → 校验界面）、指纹确认卡片，或失败时的错误卡片（可重试 / 诊断 / 返回）。
- 下半部分是**连接日志**：Host 在连接全程写下的逐行日志（SSH 目标、指纹、探测结果、托管 Node 下载 / 安装、npx 取包、远端 DSH 启动、隧道、校验、失败原因），等宽字体、按级别着色（debug 弱化，warn / error 用状态色），新行到达时自动滚到底部，用户往上翻则停止跟随。它来自 `HostView.logs`（[api.md](api.md)），经日志通道 `GET /events/logs` 推送；状态帧 `/events` 只带状态与进度（v2.12）。
- **每次连接从干净的日志开始**：手动连接 / 重连 / 自动重连都会清空上一次的行与序号，先写一条带次数与时间的边界行（`— 第 N 次连接 · 时刻 —`），所以面板默认只有本次连接；每行还带写下它时所在的阶段（`phase`），面板在行首显示阶段标签，滚动时能看出停在哪一步。
- **失败时日志自己就能说明问题**：失败被写成多行 `error` 级日志，顺序是「失败阶段 + 错误码」→ 双语原因（与错误卡片同一句）→ 每一条建议 → 脱敏并 `headTail` 截断的技术细节；`remote-dsh-start-failed` 的技术细节是远端日志尾部，逐行打印。日志里的双语行由 Host 下发 `text: { zh, en }`，面板按当前语言渲染。
- 关窗不中断连接：连上后窗口自动闭合并接管整窗；失败时窗口留着，日志与错误一起可见。「返回」与主机条里的「管理界面」都回到主机清单。连接到一半关掉窗口也照样继续，回「管理界面」点那张正在连接的卡片（或它的「查看进度」，主机条里点这台主机等价）就能把同一份进度与日志重新打开。日志行本身不改写、不脱敏；脱敏只发生在**技术细节行**与**导出的诊断包**里。
- 本地重启远端（§5.5）、主机卡片上的「重连」与远端自重启的**重挂**（§5.6）复用同一套阶段、日志与失败说明：状态是 `connecting`、重启时进度码是 `restarting-remote`（标题也换成「正在重启「{name}」的远端 DSH…」而不是「正在连接」），所以不会出现「连接断开」的错误卡片；失败走 `logFailure` 的多行解释（阶段、错误码、原因、建议、脱敏细节）。成功后方才回到 `connected` 并让承载方重新导航。重启 / 重连结束时窗口回到主机清单，日志留在本次窗口里可见。

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
- 平台模式的具体形态（都是实现事实，正常配色下零像素差）：`prefers-reduced-motion: reduce` 下浮层内所有动画与过渡归零到 `0.01ms`、只保留 spinner 以 2.4s 继续转（表示仍在进行），注入远端页面的主机条则直接 `animation:none`；`forced-colors: active` 下对话框与抽屉各补 1px `CanvasText` 边框（强制色把两者都压成 `Canvas` 并去掉阴影，边框是唯一的分界，`box-sizing: border-box` 保证盒子尺寸不变）；键盘焦点始终保留轮廓，只有指针焦点才移除输入框 `outline`（`:focus:not(:focus-visible)`），注入到其他文档的两个表面各自带 `:focus-visible` 规则。
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
- **信任边界**：所有来自 carrier 的 intent 都先过 `sanitizeGuestIntent`：只放行 `download-file` / `open-external` / `clipboard-write` / `notify` / `add` / `manage` / `disconnect` / 切换目标；下载的目标主机被**强制覆盖**成该 carrier 自己的 hostId（guest 自带的 `hostId` 不会生效）；断开只接受该 carrier 自己的 hostId，其他值直接拒绝；切换目标只接受 `local` 与本 carrier 的主机。宿主推给 guest 的主机条也只投影这两项，所以远端页面既看不到、也断不了其他主机。跨主机切换要从远端页面点「本地」再选（这是刻意的信任收窄；本地页面自己的主机条不受影响）。这条收口与 §7 的信任说明一致。
- **桌面载体**：guest 有自己的分区，但 `<webview>` 的 `window-open` 处理在 DSH 桌面主进程里（`shell.openExternal` 也只有那边能调），插件客户端半端装不上 `setWindowOpenHandler`。桌面路径因此复用同一条桥：guest 里的链接/`window.open` 经队列回到本地页面，由该页面打开。**边界**：桌面壳若不让渲染进程开新窗口，链接就只是被丢掉（`noopener` 让返回值无法区分「打开了」和「被拦了」，桥不猜）；这一路的需求侧修复是 DSH 桌面桥暴露一个 `openExternal(url)`，属于后续工作，本 PR 没有假装覆盖。
- **不在本仓库**：前端 bundle 里的 `writeClipboard`（reject 后不回退、失败不提示）与 `openExternalLink`（在 frame 内自开侧栏/`window.open`）无法在插件里改。桥在**调用点**上等效修好了它们：`writeText` 现在总是成功或可见失败，外链总是在顶层打开；但前端自己仍可能选择「侧栏 browser」分支（那是 DSH 的设置），那个嵌套页面不是本插件能改的。

### 4.9 AI 工具（本地 LLM 会话查看主机）

本地会话里的模型不需要用户先点主机条就能知道「有哪些主机、哪台连着、那台为什么失败」：Host 半端向 DSH 的 `tools` 服务注册**一个只读工具**。它只注册在**本地 Host**（浏览器半端是 UI bundle，远端 DSH 也不加载本插件），所以远端会话看不到它，也不新增 HTTP 路由。

- `remote_hosts_list`（只读）：参数只有 `includeDisconnected`（默认 true）；返回 `{ ok, hosts, count, connected, truncated? }`（最多 500 行，超出时 `truncated` 为 true），每行 `id` / 名字 / 状态 / 是否已连接 / 地址 / 最近一次失败 / 当前进度码 / 远端 DSH 版本。声明 `isConcurrencySafe`（只读可并发）；**不声明 `timeoutMs`**——函数体只有一次本地快照读取加同步投影，没有可协作取消的等待，声明了反而误导。
- **没有写操作面**：增删改、连接 / 断开 / 重连、重启或关闭远端 DSH 一律留在主机条的「添加主机 / 管理界面」里。因此工具既不需要审批门，也不需要 `confirm` / `dryRun` 参数——它不改变任何状态。
- **白名单投影**：字段按名字挑（不 spread 配置或 HostView），再过 `redactText` 并按字段限长；**在 `redactText` 之外再抹掉两类只有主机才有的标识**：整段 `SHA256:<base64>` 指纹（大小写都认，连算法前缀一起去掉——`host-key-unknown` / `host-key-changed` 的失败原因原文带它）与密钥文件路径（`.ssh` 必须是完整路径段，另外 `.pem` / `.key` / `.ppk` 结尾或 `id_*` 命名的密钥文件也算——`auth` 失败会引用配置的密钥文件）。密码、token、cookie 与私钥路径都不进结果，`output.schema` 是 `additionalProperties: false`，投影里多一个未声明字段会让调用失败而不是漏出去。**匹配一律线性**且先按字段上限切输入再跑正则：`address` 在 `settings.js` 里只做 trim、上游没有长度上限，而投影是同步的，不能让一条超长字段把宿主事件循环拖住（嵌套量词的路径正则在这种输入上是二次复杂度）。返回值里的远端主机名、版本与错误文本是不可信数据。
- **可选服务**：`tools` 不写进 `inject`；注册**总是**走 `ctx.inject(['tools'], …)`，由 cordis 在服务缺失时 park 该子 fiber、服务出现**或被替换**时重新 apply，所以既不因缺服务停掉插件（主机条与 HTTP API 照常工作），也不会因为启动顺序或服务重载永久丢工具。`ctx.inject` 返回的是 **fiber 而不是 disposer**，卸载时对它调用 `dispose()`；老内核没有 `ctx.inject` 时退回 `ctx.get('tools')`（取不到就跳过并记一条日志）。
- **不做的事**：不碰远端 `~/.dsh`；不改已有 API 语义；不提供任何写动作（将来若要加，必须同时补上「不依赖 DSH 审批」的确认门——`approval.policy='never'` 的会话会确定性拒绝 `tools/pre-execute` 的 ask）。

## 5. 连接生命周期
### 5.1 状态、阶段与进度
| status | 含义 |
|---|---|
| `unconfigured` / `disconnected` / `error` | 尚未连接过 / 断线可重连 / 连接、认证或服务失败 |
| `connecting` / `fingerprint-pending` / `conflict-pending` | 连接中（配合 phase / progress）/ 等待确认主机指纹 / 远端已有手工启动的 DSH，等待用户选择 |
| `connected` | 远端界面可用 |
| `limited` | 保留状态：能连但远端无法提供界面 |

`phase` 取值：`ssh` → `probe` → `bootstrap` → `start` → `tunnel` → `verifying` → `ready`。进度码是细粒度、可本地化的 `{ code, params }`，具体列表以 [api.md](api.md) 为准；客户端只按 code 查文案，不推断连接逻辑。

`connecting` 不只表示首次连接：本地重启远端（§5.5）、远端自重启后的重挂（§5.6）与显式关闭远端（§5.7）也用它，
但进度码分别是 `restarting-remote`、`restarting-remote` 与 `stopping-remote`：重启/重挂阶段只走 `start` →
`tunnel` → `verifying`，关闭只走 `start` 并以 `disconnected` 结束；三者都不会重跑 `ssh` / `probe` / `bootstrap`。
主机卡片据进度码显示「重启中」/「关闭中」而不是「连接中」。`remote-unreachable` 是这些动作之外的一种**错误**
（没有可重挂实例时才出现，§8），不是状态。

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

本地重启（§5.5）与远端重挂（§5.6）复用上表的**尾段**：`[start]` → `[tunnel]` → `[verifying]` → `connected`，但跳过 `[ssh]` / `[probe]` / `[bootstrap]`，因此既不会重跑托管 Node 与 npx 预检，也不会再次索要密码或主机指纹；失败同样落分类错误，重挂失败额外保留 SSH 会话以便用户直接重启或重连。

### 5.3 主机指纹
- ssh2 `hostVerifier` 内计算 OpenSSH 形式的 `SHA256:<base64>`。
- 已记录指纹：匹配放行；变化 → `host-key-changed` 阻塞。未记录且 known_hosts 有该主机条目：任意一条匹配即放行（等价 OpenSSH），无匹配 → `host-key-changed`。
- 首次使用且无记录：`fingerprint-pending`，等待 `POST /hosts/:id/fingerprint`；超时按拒绝处理。
- `strict` 策略直接拒绝未知指纹，不弹窗。
- **跳板机与目标各有自己的 host-key 上下文**：目标的策略与 `pinnedFingerprint` 只描述目标；跳板只受**全局** `hostKeyPolicy` 约束，
  它的 pin 只记在本次会话的 `runtime.jumpFingerprint`（带 `host`/`port`），**绝不写进**目标的 `pinnedFingerprint`。因此：
  - 跳板确认的 remember 是「本会话记住」：插件重启后会重新询问跳板指纹（store 的 `pinnedFingerprint` 属于目标，无字段可存跳板 pin；
    这是存储契约的既有边界，不为此改 `settings.js`/`store.js`）。
  - 改了主机的 `jumpHost`（或端口）后，旧跳板 pin 因 `host`/`port` 不匹配被丢弃并重新询问，不会把新跳板报成 `host-key-changed`。
  - **已知限制**：Client 的指纹对话框不区分跳板 / 目标，也复用「确认后会记住」的固定文案；Host 侧保证对话框里显示的**密钥**是当前被确认的那一把
    （跳板确认期间 `HostView.fingerprint` 是跳板密钥，拨号目标前清空），但文案无法按角色改写（`client.js` 不在本改动的范围内）。
- **known_hosts 的已知限制**：只按主机字段（`host` / `*` / `?`，非 22 端口只认 `[host]:port`）匹配，不支持 `|1|` 哈希行
  （只统计数量，不猜测明文）与 `!host` 否定行。注意否定行**不是**「更严格」而是**更宽松**：本实现忽略 `!`
  前缀，把 `!bad.example` 当成普通模式，因此 `*.corp.example,!bad.corp.example` 里只要有一行非否定模式匹配
  就放行——OpenSSH 会排除 `bad.corp.example`，本实现会信任它。同一 `known_hosts` 里多条同主机条目时，任一
  非否定指纹匹配即放行（与 OpenSSH 的「任一匹配即放行」一致，但少了否定排除）。

### 5.4 断线、重连与退出
- SSH 连接 `close` 且用户期望保持连接时：状态转 `disconnected`，按设置做指数退避重连（`autoReconnect.maxAttempts`）。
  预算只在**成功**（`markConnected`）与**用户手动连接**（`startConnect`）时归零；失败继续排下一次，用户在提示框点「取消 / 拒绝」或提示超时则不自动重试。
  连接期间（含 `[probe]` / `[bootstrap]` / 指纹提示）的断线同样按 `network`（`reason=ssh-closed`）处理并进入重连。
- 手动断开：关隧道；`keepAlive=stop` 同时停远端，`idle` 延迟停止，`keep` 保留远端。
- **空闲计时器只是「空闲主机」的策略**：任何一次新的连接（`startConnect`）与每次成功挂载（`markConnected`）都会取消它；计时器触发时若
  `desired==='connected'` / `status==='connected'` / 仍有隧道，直接返回 `still-wanted` 且**不释放** SSH（旧实现会把用户刚接回来的链路杀掉并留下
  「状态 connected 但 ssh/隧道已空」的僵尸态）。空闲停止还要求 `/proc` 身份证明（starttime、DSH home、profile 与记录一致）通过，
  pid 复用 / 不属于本连接时不发信号；idle 保留的旧 SSH 在下一次连接开始时先释放，不再被覆盖后泄漏。
- 删除主机：先取消重连 / 空闲计时器、置 `desired=idle` 并清 `activeHostId`，再 teardown，最后删记录；远端按该主机的存活策略处理。
- 本地 DSH 退出：`shutdown()` 先对每台主机置关闭标志，再执行同样的 teardown。

### 5.5 本地主动重启远端
`POST /hosts/:id/restart`，仅 `connected` 可用；`remote-unreachable` 错误状态（§5.6 有意保留了 SSH 会话）也允许用它恢复。响应先 `accepted`，进度走 `/state`。它**不重跑** `[ssh]` / `[probe]` / `[bootstrap]`，因此不会再次索要密码或主机指纹：

```text
restart(id)（同一条 SSH 会话）
  ├─ 先弹冲突提示（若有手工实例），用户取消时**尚未停止任何东西**，保留原连接与隧道
  ├─ 只有同时满足三条才允许 kill：
  │   1) run registry 命名它；2) 本连接实际启动过它（start 脚本的 pid，或 adopt 自 launch 记录）；
  │   3) /proc/<pid> 的 starttime 与记录的启动时刻一致（排除 pid 复用），cmdline/env 仍是同一 DSH home/profile
  │   不满足就不 kill；只要这个 pid 仍存活且不是用户选过的 alongside，就把「本连接无法停止的实例」
  │   一并交给冲突流程（stop / alongside / cancel），**绝不静默起第二个实例**
  ├─ [start]  用已记录的 facts/plan 重新 npx 启动（`--port 0` → 新端口、新 token），记录新 pid 身份
  ├─ 刷新 run/web.json（新 pid/port/version/profile/dshHome/launch；origin 标为 launch）
  ├─ 关旧隧道 → [tunnel] 按新端口重建 → [verifying] 重新 token → cookie 种入
  └─ connected：`remote.viewRev` +1，承载方（guest / iframe）重新导航到新的 `GET /hosts/:id/open`
```

重启是一次性动作：结束后仍按原 `keepAlive` 策略走，不写远端 `~/.dsh` 的插件、配置与凭据。动作内创建的隧道在 `finally` 里收尾：disconnect / 删主机 / 退出让令牌失效时，监听器一律关闭并清空 `remote.localPort`，绝不留下持有已释放 SSH 的隧道。失败按连接失败同样收尾（分类错误 + teardown），主机与配置保留。客户端在这段时间打开这台主机的**连接窗口**（§4.4）：标题是「正在重启「{name}」的远端 DSH…」，下半部分照常打印 Host 写的重启日志；动作结束后窗口回到主机清单。

**重挂后重启（N3）**：真实形态里启动脚本的 `$!` 是 npx 包装进程，而监听者是它 spawn 的 DSH 子进程；重挂记录的是后者（端口 owner），本连接的 `launched` 里没有它。因此重挂后点重启时，这个实例不是「可 kill」，但仍是**已知、存活、非 alongside** 的实例：它会被合并进冲突提示（即便 registry pid 本来在扫描的 ignore 列表里），用户选 `stop`（显式停止）或 `alongside`（显式并存）后才继续 `[start]`；`cancel` 保留当前连接。选择 `stop` 后 `stoppedOwn=true`，后续失败不会“恢复”一个已经停掉的实例。这条也覆盖「registry 与 pid 不匹配 / pid 复用但仍是同 home+profile 的 DSH」。
关于身份校验的边界：`killAuthorized` 在 `/proc/<pid>/environ` 不可读（`DSH_HOME` 为空）时允许继续，只依赖 starttime（exec 不变、pid 复用必变）+ cmdline 的 `--profile`；这已足以排除误杀，且方向是 fail-closed（读不到 identity 直接不杀）。与之相对，`resolveRemoteWeb` 的接管路径要求 `DSH_HOME` 必须可读并等于真实 home，因为那里是在「选择接管一个陌生进程」，标准更严。

冲突扫描自身的失败也不允许 fail-open：`knownProcess` 在扫描失败分支**之前**合并，扫描失败但仍有已知存活实例时照常弹冲突；只有扫描失败且没有任何已知实例时才继续（旧行为）。另外，`stopWeb` 返回 `ok:false`（停止未确认）时不 `[start]`：保留原连接与隧道、在主机卡片给出 warning，用户可重试或先断开。`stopWeb` 返回后（以及 `resumeConnected` 内部）都会重新确认动作令牌与链路仍然有效（`desired === "connected"`、SSH 仍在、隧道仍在）：disconnect / removeHost / SSH close 正好发生在停止在途时，迟到的重启动作不会把状态写回 `connected`，也不会重新启动心跳。

### 5.6 远端自重启：心跳、确认与重挂
远端 DSH 可能自己重启（插件市场更新、supervisor、远端重启），而启动命令固定 `--port 0`，所以**重启后端口一定变化**，且市场发起的重启不会写插件的 `run/web.json`。处理分三层：

1. **故障上报**：同源代理或隧道的 `ECONNREFUSED` / `ECONNRESET` 只上报一次 `remote-unreachable` 疑似事件（SSE 同名事件带 `phase: suspected`），由探活确认，不把一次请求失败当成进程重启。同一类上报在 recovered 后有 15s 冷却窗口，避免「隧道坏、远端健康」时反复抖动。
2. **轻量心跳**：连接成功后每 `remoteHeartbeat.intervalSec`（默认 30s，可在设置里关闭并即时生效）用 `remoteHttpStatus` 探一次远端端口。只有**连续两次**探活失败才判定远端不可用；两次之间有一次成功就清零。疑似事件触发的确认同样要两次探活，间隔约 0.75–1.2s。若远端健康但页面请求失败（典型是隧道坏了），恢复阶段先**问本地监听器**：能应答（任何 HTTP 状态都算）就保持不动；本地不应答才重建监听器（同一远端端口、token 不变），而不是把远端判成重启。重建是**先建新 listener、再关旧的**（避免无监听窗口），失败时保留旧 listener 并按 30s→120s 退避，不会因单个 `forwardOut` 失败或坏 listener 反复重建。
   - 新 listener 的本地端口是新的随机端口，因此重建成功后 `remote.viewRev` +1：承载方重新 `GET /hosts/:id/open` 并导航（桌面 guest 的地址就是回环 `localPort`，不 bump 会停在已关闭端口）。重建关闭旧 listener 会**短暂断开现有 WebSocket 与下载**，这是预期行为（文档与 CHANGELOG 已写明）；浏览器 iframe 会随 `viewRev` 重新加载同一路径。
   - 重建本身也是一次一次性动作：持 link-work 令牌，`finally` 在令牌失效时关闭自己创建的 listener 并清 `remote.localPort`/`tunnel`；`disconnect` / `removeHost` / `shutdown` 会先取消再 **await** `runtime.tunnelRepair`，因此不会在 teardown 之后才发布 listener。
3. **重挂而不是全量重连**（`reattachRemote`，状态 `connecting` + 进度码 `restarting-remote`）：
   ```text
   重读远端真实状态（resolveRemoteWeb，最多重试数秒），一个候选必须同时满足：
     ├─ 监听端口属于该 pid（registry 存活 pid 的 /proc 监听端口；否则用端口反查 pid）
     ├─ /proc/<pid> 的 cmdline 含 `--profile <profile>` 且 environ 的 DSH_HOME 等于本连接的真实 home
     └─ 最新 `dsh web:` 行命中的是同一个端口（launch token 只能来自这一行）
   token 为空 → 明确失败（真实 DSH 对 `/?token=` 与无 cookie 请求都回 401），绝不假装成功
   版本：cmdline 的 `@deepseek-ai/dsh@<ver>`，或 argv 指向的 `node_modules/@deepseek-ai/dsh/package.json`；
        证明不了就保持未知，不把本机版本写进 registry「洗白」
   校验通过 → 刷新 run/web.json（origin=reattach）→ 关旧隧道 → 按新端口重建 → 重新 token → [verifying]
             → connected；写连接日志（重挂原因）与诊断 `restarts`；`remote.viewRev` +1，承载方静默重载
   没有可重挂实例 / 拿不到 token → 报可解释的 `remote-unreachable`，保留主机、配置与 SSH；
            用户可点「重启」或「重连」（进程扫描只用于解释 `no-token`，不产生接管）
   ```
   运行期发现的新实例属于这条 `keepAlive` 连接对应的主机（同一 `~/.dsh`、同一 profile）时**静默重挂**；重挂发现的 pid 只有显示/承载权，**没有 kill 权**（`run/web.json` 记 `origin: "reattach"`，下一次连接 adoption 也只接管不授权）。重挂成功后 `launched` 只保留与当前监听 pid 相同的条目（包装进程的旧 pid 被清理），所以真实 npx 形态下重启会走 §5.5 的冲突提示而不是静默双实例。远端若将来提供重启广播（SSE / 关闭码），接进同一个 `noteRemoteUnreachable` 入口即可，当前不依赖它。

### 5.7 关闭远端 DSH（显式停止）
`POST /hosts/:id/stop-remote`，管理界面卡片上的「关闭」：这是**显式、破坏性**的一次性动作，
与按存活策略处理的「断开」不同——目标是**停掉本连接管理的那个远端 web 进程**，然后释放整条链路。仅
`connected` 可用；`remote-unreachable` 错误状态也可用（§5.6 有意保留了 SSH），此时远端进程多半已消失，
动作退化为「清掉残留 registry 再释放连接」。其余状态、以及另一个一次性动作进行中，一律 409
`stop-unavailable`。

```text
stop-remote(id)（同一条 SSH 会话，同步执行；期间 /state = connecting + stopping-remote）
  ├─ 授权（closeAuthorized，与 §5.5 同一套 /proc 证明，另加两条）
  │   1) pid 必须就是本连接绑定的那个（remote.pid），且不在 alongsidePids 里
  │   2) 本连接记录过它：launched（自己启动 / launch 记录收养）或 bound（重挂接管时的 /proc 身份）
  │   3) run/web.json 仍命名该 pid，dshHome / profile 一致
  │   4) /proc/<pid> starttime 与记录一致，cmdline/env 仍是同一 home/profile
  │   任一不满足 → 不 kill，409 + 可读原因；连接保持原样（不会半停）
  ├─ pid 已消失 → 不 kill，只清 run/web.json（clearRunRegistry，绝不按残留 pid 发信号）
  ├─ 否则 stopRemoteWeb(pid)：SIGTERM → 等待 → SIGKILL，并删 run/web.json
  └─ 复用 disconnectHost(..., {stopped:true})：抑制存活策略自己的停止（不再发第二次信号）与空闲停止；
     desired=idle、取消重连 / 空闲计时器 / 心跳、关隧道、释放 SSH、status=disconnected、progress=null；
     主机条目、凭据与 keepAlive 不变
```

- 为什么需要一个新端点而不是 `disconnect {stopRemote:true}`：后者是策略收尾（`keep` / `idle` / `stop`），停止
  远端时直接用记录的 pid、没有归属证明，也没有可观察的进度码；而「关闭」必须拒绝无法证明归属的
  pid，并把动作过程（`stopping-remote`）与拒绝原因（409 + `stop-unavailable`）告诉用户。两者的语义在
  [api.md](api.md) 里分开写。
- 停掉后不触发自动重连（`desired = idle`），卡片回到「断线」，点「重连」重新走完整连接管线起一个新实例；
  因为 `run/web.json` 随停止被删除，下一次 connect 不会把死 pid 当残留实例、也不会弹「远端已有手工启动的
  DSH」冲突（§6.3）。
- `disconnectHost(..., {stopped:true})` 同时抑制存活策略自己的停止（`keepAlive: "stop"` 平时会在 teardown 再
  发一次 stop）与空闲停止：那次信号的 pid 是几条 SSH 命令之前记录的，动作刚证明它该停（或已消失）之后再来
  一次，正常时是冗余、pid 复用窗口内就是误杀；这也与本端点「pid 已消失绝不发信号」的契约一致。
- 重挂接管的实例（`origin: "reattach"`）**不会被自动或静默停止**：显式关闭走本端点，`bound` 记录的是接管时
  `/proc` 证明过的 starttime，关闭前再核对一次，pid 复用即拒绝；重启（§5.5）遇到这类实例时把它并入冲突提示，
  由用户选择「停止它」（那条路径走既有的 `stopForeign`，与本端点的 `/proc` 授权互不替代）。`alongside` 保留的
  进程任何路径都不杀。

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
- 收养：读插件状态目录的 `run/web.json`，要求 pid 存活、日志 URL 可解析、HTTP 可达。收养让本地重启后复用远端实例。记录里 `origin: "launch"`（启动脚本或本地重启写的）才授予 kill 权；`origin: "reattach"`（运行期重挂写的）只接管显示。
- 冲突：远端已有手工启动的 DSH 时，列出进程并让用户选 `stop` / `alongside` / `cancel`；`alongside` 会在主机卡片留下共享 `~/.dsh` 的 warning，并记住这些 pid，之后本地重启远端时不再重复询问（§5.5），且这些 pid 永不被自动 kill。
- 运行期重挂（§5.6）与连接期收养不是一回事：重挂只用于本连接对应的主机（同一 `~/.dsh` + profile），不弹冲突提示；连接期才需要用户在「停掉手工实例 / 并存 / 取消」之间选择。

### 6.4 存活策略
| 策略 | 本地断开时 | 本地 DSH 退出时 |
|---|---|---|
| `keep`（默认） | 只关隧道，远端继续 | 保留远端进程 |
| `stop` | 停止远端 web 后关隧道 | 停止远端 web |
| `idle` | 关隧道，N 分钟后停止远端 | 保留（按 keep 处理） |

显式的「关闭」（§5.7）不受这张表影响：它总是停掉本连接绑定的那个远端进程，然后释放 SSH，
不会留下空闲计时器。

### 6.5 凭据与远端数据
连接只读取远端的版本、端口与运行状态；远端 `~/.dsh` 里的插件、配置、凭据与会话始终由远端自己维护，
本插件不写入、不删除。API key 需要在这台机器上使用时，由用户在远端界面里自行配置。

## 7. 安全
- 远端界面只绑 `127.0.0.1`，经 SSH 隧道访问；本地 HTTP API 与同源代理只挂在本机 DSH Web 服务上。
- 准入与 DSH 自带路由一致：每条请求先进 `ctx.connection.requestRejection`（Host/Origin 栅栏 + 浏览器会话），
  内核没有该服务时退回插件自己的栅栏（旧内核仍可用）。`/health` 不要求会话，但仍过 Host/Origin 栅栏。
- 本地 API：`x-dsh-remote-go: 1` 头 + `Host` 必须是本机 origin + Origin 同源 + 拒绝 `sec-fetch-site: cross-site`；
  `/events` 只做 Host/Origin 栅栏（EventSource 不能加头）。同源代理使用同一份 `request-trust.js` 栅栏。
  `Host` 检查挡的是 DNS rebinding：攻击页只能用 `Host` 声明自己的域名，而 `Host` 是它无法伪造的字段。
- 同源代理只服务**已连接主机**：未知 / 未连接 id 直接 404，不建立上游连接；不代理调用方给出的任意 URL。
- 远端 session cookie 只存在 Host 侧 per-host jar，浏览器拿不到；本地 DSH 的 cookie 也永不转发给远端。
  转发时 `Host`/`Origin` 改写为远端 listener 的 authority，远端的同源与 cookie 校验仍成立。
- 密码只在连接或 `POST /hosts/:id/password` 请求里出现；默认写入 DSH 凭据存储（键为 `<owner>/<id>`，不写 `hosts.json`），
  取消「记住密码」时只用于本次连接并删除已有记录。launch token 默认只在内存，
  只出现在首次导航的 `url` / `webUrl` 里。
- 诊断导出统一脱敏（token / 密码 / 私钥 / 家目录）；桌面 guest 自己管理 cookie、下载与权限，插件不读取 guest 内容，
  只注入主机条与推送状态。
- 能力桥的授权面与它的能力一样窄：跨进/跨出 frame 的只有「用户点的那个 http(s) 链接」「要写进剪贴板的文本」「一条提示」。
  链接先经 `externalUrlOf` 收窄（http/https、必须有主机、不带凭据、≤8KB），再交给浏览器；顶层 `window.open` 用
  `noopener,noreferrer`（打开的站点既拿不到 `window.opener`，Referer 也不含本页 URL），因此无法从返回值判断弹窗是否被拦，
  桥不重试、不换通道，也不对被拦弹窗报错。桥**不提供读剪贴板**，也不把本地
  页面的任何状态交给 frame。intent 在收口处另有白名单与 hostId 覆盖：来自 carrier 的下载/断开只能作用于该
  carrier 自己的主机，切换目标只接受 `local` 或自身主机（§4.8），未知 action 一律丢弃。**这些护栏不是对远端页面
  的隔离边界**：frame 的 `allow=popups` 让远端页面自己的 `a[target=_blank]` 可以原生开任意 URL，绕开桥与
  `externalUrlOf`；`clipboard-write` 也不校验手势，远端页可以在本地页聚焦时静默覆写剪贴板；同源 frame 本来就能
  直接访问父文档。它们都建立在「frame 里的页面 = 用户自己连的那台远端 DSH」这一信任前提上，intent 收口只是让这条
  通道的行为收敛到「对自己的主机」，不宣称把远端页关进沙箱。`localStorage` 分区（`configurable:false`，页面不能
  `delete` 后回落到共享存储）是数据卫生（防止偏好互相覆盖），不是同源隔离的安全边界。
- **模型工具的返回值同样是「对外输出」**：`remote_hosts_list` 只做字段白名单投影（再过 `redactText`、按字段
  限长），密码、token、cookie、指纹原文与私钥路径都不进结果；`output.schema` 的 `additionalProperties: false`
  让多出来的字段变成失败而不是泄漏。工具**没有写操作面**（维护仍在管理界面），所以不需要审批门；若将来加写动作，
  必须自带确认门——DSH 的审批在 `policy='never'` 时会确定性拒绝，不能把「问用户」寄托在审批上。返回值里的远端
  主机名、版本与错误文本属于不可信数据。

### 7.1 同源 iframe 的威胁模型（产品级）

浏览器半端把远端界面放进**同源** iframe（`/dsh-remote-go/remote/<hostId>/`），因此必须先说清一个前提：

- **远端被入侵 = 本机 API 被可信调用。** 被攻陷（或本身就是恶意）的远端 DSH 在那个 frame 里拥有本机 origin 的
  脚本能力：它可以直接 `fetch('/dsh-remote-go/api/…', { credentials: 'same-origin' })`，带上 `x-dsh-remote-go`
  与任何同源请求头，浏览器不会给这类请求任何额外信号。标识头 `x-dsh-remote-go: 1` 是**常量**，写在本仓库与打包
  产物里，**不是鉴权**：它只挡随手 curl 与旧的跨站路径，挡不住已经在本机同源文档里的脚本。真正的准入是 DSH 自己的
  浏览器会话（`ctx.connection.requestRejection`）加 Host/Origin 栅栏，而 frame 天然满足它们。
- 这是**产品决策**，不是可以就地修掉的实现缺陷：只要保留「整窗使用远端界面」，frame 里的页面就必然与本机同源。
  收窄它只能把敏感动作搬到需要用户手势的通道（桌面 guest、本地确认弹窗），那是另一种产品形态。本版本**不宣称**
  对「被入侵的远端」提供隔离，只做两件事：把最重两条链路的破坏面压到最小，并让用户知道自己信任了什么。

两条最重的链路与已加的缓解：

1. `POST /downloads`：远端决定**写什么内容**（文件字节），也决定**写到哪里**（`destination` 下新建的文件/目录名
   就来自远端文件树）。
   - `destination` 必须是本机用户主目录之下，且不是系统目录、自启动目录（`Startup` / `autostart` / `systemd` /
     `Start Menu\Programs` / macOS `Library/LaunchAgents`、`LaunchDaemons`、`StartupItems`）、凭据目录
     （`.ssh` / `.gnupg`）、登录脚本与用户配置目录（`.bashrc` / `.profile` / `.zshrc` / `.xsessionrc` /
     `.config` / `.local` 等）；`shell:startup` 一类未解析的 shell 路径直接拒绝。Windows 与 macOS 的路径比较
     按各自文件系统的大小写不敏感语义做归一。目标是把「远端不能把
     可执行内容放进下次登录会执行的位置」这件事挡住，不是「任意内容都可以安全下载」。
   - **远端命名的最终路径同样过关**：`destination` 合法不代表 `destination/<远端名字>` 合法。远端文件夹名
     `autostart` / `Startup` / `.ssh`、远端文件名 `.bash_login`，以及会在其下生成受保护路径的上级目录
     （如 `AppData/Roaming/Microsoft`，其下就是 `Windows\Start Menu\Programs\Startup`）都在创建前被拒绝，
     拒绝时零写入。
   - 仍然可以写入 `~/Downloads` 这类正常位置：「用户自己选目录」是产品语义，栅栏只限制根集合与危险子目录，
     越界时给可读原因（`invalid-input` + `destination`）。
   - 注意 `HostView.authKeyPath` 与 `GET /keyfile/list` 仍会把本机 home 下的绝对路径交给同源 frame（既有契约，
     也是目录选择器的信息来源）。它们不是秘密，但在本条修好之前，那正是远端定位 `destination` 的线索；本条的
     栅栏不依赖「远端不知道 home」。
2. `POST /hosts` + `POST /hosts/:id/connect`：远端可以新增/覆盖主机条目并触发连接，把本机 SSH 客户端指向它控制的
   地址。
   - 主机 `id` 只由 Host 签发：客户端传来的未知或畸形 id 一律替换成新的 `h_*`，不能伪造或占用别人的条目（`id` 同时
     是代理路由与凭据记录键的一部分）。
   - 连接仍要真实 SSH 认证与主机指纹确认；密码不经 `POST /hosts` 传输，`hosts.json` 不含密码；密码默认存
     DSH 凭据存储并在 DSH 重启后继续复用，取消勾选或删除主机时清除。
   - `POST /local-version` 只在探测失败时接受回填，且不得低于 `engines.dsh` 下限，避免远端把 npx 运行时钉到任意版本。

同源代理本身的方向性边界（不是隔离，是「不要让远端在同源上做它本来没资格做的事」）：

- 请求头是**白名单**：本机会话的 `authorization` / `cookie` / `x-dsh-*`、`forwarded` / `x-forwarded-*`、
  `sec-fetch-*` 一律不发给远端；只有 `accept*` / `content-*` / `range` / `if-*` / `cache-control` /
  `user-agent` / `x-requested-with` 与 WebSocket 握手头能过去。
- 响应头按名丢弃 `clear-site-data`、`access-control-*`、`refresh`、`content-location`、`report-to`、`nel`、
  `permissions-policy`、`alt-svc`；**WebSocket 的 101 响应头也走同一套策略**；`Location` 只允许折回远端自己的
  listener，其它绝对地址（含 `//host`、带反斜杠的“相对”引用、其它 loopback 端口）一律丢弃，避免这条 frame 被
  导航去钓鱼页。
- 远端 cookie 只存在 Host 侧的 per-host jar（≤64 条、值 ≤4 KiB，`Secure` cookie 不入明文 jar）；上游 30s
  无响应即 502，不把本机请求无限挂住。

错误与诊断文本同样在这个前提之下：`ErrorView.technical` 会带远端进程输出（第一行就是带 token 的 launch URL），
所以它在序列化前统一脱敏（token / 密码 / 私钥 / 家目录）并限长；连接日志在写入 ring 时脱敏（`HostView.logs`、
SSE 状态帧与诊断导出读的都是它，所以 `/state` 与 `/events` 不再含 token）；`GET /diagnostics/self` 的
`home` / `stateDir` 同样脱敏。这些是数据卫生，不是隔离边界。

## 8. 失败与恢复
| 场景 | 表现 |
|---|---|
| 网络不可达 / 认证失败 | `network` / `auth`，可重试 |
| 指纹变化 / 未知 | `host-key-changed` / `host-key-unknown` |
| 远端装不上托管 Node / npx 失败 / 远端启动失败 | `remote-node-install-failed` / `remote-dsh-missing` / `remote-dsh-start-failed` |
| 远端已有手工 DSH | 暂停为 `conflict-pending`；取消时 `remote-dsh-running` |
| 远端自己重启后找不到可重挂实例 | `remote-unreachable`（保留主机与配置；可点「重启」或「重连」） |
| 版本不一致 / 隧道或界面校验失败 / 非 Linux | `version-mismatch` / `remote-ui-unreachable` / `unsupported-os` |

失败后状态与错误都通过 `/state` 与 SSE 推给客户端；重试从干净状态重新走管线。

## 9. 验收
1. 在干净 profile 安装插件，设置面板里**没有**插件的页面；侧边栏顶部出现主机条，可从「添加主机」或「管理界面」添加并连接一台真实或模拟远端。
2. 首次连接完成指纹确认、托管 Node 准备、npx 预检、隧道与界面校验；主机卡片显示版本与状态。
3. 桌面端：点某台主机后远端界面铺满窗口，本地与远端侧边栏顶部都有主机条；浏览器端：同一操作让远端界面进入
   同源 iframe，主机条同样出现在远端侧边栏顶部。两端都能点「本地」回来；本地页面那份行可直接点另一台切换，
   远端页面里的行只列「本地」+ 当前主机，跨主机切换要先回本地再选。
4. 断线后按设置自动重连；手动断开 / 关闭本地不误杀远端任务（按策略）；诊断导出包含 10 项检查且已脱敏；中英文界面均可完整操作。
5. 浏览器端在远端界面里：代码块/工具输出的「复制」真的写入剪贴板（失败有提示），点消息里的 `https://` 链接在顶层标签页打开
   （页面不会被导航走、也不出现空白嵌套页），远端与本地改偏好互不影响；麦克风与登录弹窗所需的 `allow` 已声明。
6. 本地会话里问「我有哪些主机 / 哪台连着」能直接答出清单与状态；返回值里没有任何凭证、指纹或 `~/.ssh` 路径；
   增删改与连接仍然只能在主机条的管理界面里做，远端 DSH 的会话看不到这个工具。

## 10. 关键决策
- **桌面端整窗 guest，浏览器端同源 frame + 受控代理**：桌面 guest 行为最接近真实浏览器且不需要代理字节；
  浏览器没有 guest 席位，跨源 iframe 会混用 `127.0.0.1` 的 cookie（且 HTTPS 下被混合内容拦截），
  所以用一条只服务已连接主机隧道的同源代理换取 cookie 隔离与主机条注入能力。
- **能力用 intent 桥，而不是扩大 iframe 权限**：`allow` 只能收窄、不能扩权，剪贴板还要求顶层焦点；把「链接/剪贴板/提示」
  变成顶层执行的 intent，既能覆盖前端 bundle 里改不到的实现，也不给 frame 额外的浏览器权限。
- **本地 HTTP + SSE，而非远程 RPC**：端点少、无生成步骤、易测试。
- **重启与重挂都复用已建立的 SSH 会话**：远端端口是随机的，重连（`reconnect`）在 keep/idle 下会收养同一个进程，只有「停掉受管进程再 `[start]`」才是真重启；重挂则只重读端口、刷新注册表、换隧道与 token。两者都不重跑 SSH/探测/自举，所以不会再出现密码或指纹提示。
- **ssh2，而非系统 ssh**：需要程序化主机指纹、密码认证（可保存并在后续连接复用）与 `forwardOut`。
- **插件托管 Node + npx 固定版本**：不依赖远端环境、版本一致、无需在远端分发插件。
- **本地不复制远端能力**：插件 / 配置 / 凭据 / 设置仍在远端界面里操作；本地只负责连接与呈现。
