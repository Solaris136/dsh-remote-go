# Changelog

> **English abstract.** Notable, user-visible changes to `dsh-remote-go`, newest first. The format follows
> Keep a Changelog 1.1.0 and versions follow Semantic Versioning 2.0.0; entries are written in Chinese and
> describe behavior rather than individual commits.

本文件记录用户可感知的变更，格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)，日期为 `YYYY-MM-DD`。

## [Unreleased]

这一轮把插件从手写 JS 单体重构为 TypeScript 模块树，并把它依赖的行为写成十二条不变量（`docs/invariants.md`）。
用户能感知的差异集中在连接窗口的日志通道、浏览器端的绘制与输入处理，以及发布物的布局。

### 新增

- **连接日志独立成流（契约 v2.12）**：连接窗口的日志改走 `GET /events/logs`，状态帧里的 `hosts[].logs` 恒为
  `[]`；日志帧带 `id:`，断线可用 `Last-Event-ID` 续传，接不上时由 Host 发 `reset` 重放尾部。一次连接不再把
  几十行日志塞进每个状态帧，连接窗口的滚动也不再被状态帧打断。
- **浏览器端绘制与输入**：同一显示帧内最多绘制一次；主机列表重排保留键盘焦点；输入法组合中的 Enter 不再
  误提交；Windows 高对比度（forced-colors）下窗口边框与按钮保持可见。
- **可见文案只来自字典**：界面文案统一由 `locale/*.json` 字典产生，中英切换不再漏掉硬编码字符串。

### 修复

- **连接窗口关掉后还能回来**：正在连接的主机不再从管理窗口的主机清单里消失，卡片上直接给出当前阶段与进度；点卡片本身或
  「查看进度」都能重新打开连接窗口（重启 / 关闭远端这类一次性动作同样如此），关掉窗口后进度与日志不再无处可看。
- **回环地址校验**：同源代理只接受解析后的回环 origin，不再认可前缀伪装的地址。
- **发布物入口**：改为从 `dist/` 发布，发布包里始终带根目录 `index.js`，链接式安装与 npm 安装加载同一份构建
  产物。

### 变更

- 源码改为 TypeScript（`index.ts`、`src/**/*.ts`、`client/src/**`），`dist/` 由 `pnpm build` 生成且不进版本库；
  测试直接跑 `.ts`。

## [0.2.0] - 2026-11-17

第二个版本：把远端 DSH 从「能连上」推进到「日常可用」——连接窗口贯穿首次连接、重连与重启，SSH 密码默认
记忆，远端 DSH 可在卡片上重启或关闭并在自重启后自动重挂；浏览器端（`dsh web`）也能在同源 iframe 里整窗
使用远端界面。同时完成一轮独立安全审计（Host/Origin 准入、同源代理白名单、下载目标加固、错误与日志脱敏等）。

### 新增

- **SSH 密码默认保存并跨重启复用**：密码认证的主机在 SSH 认证通过后把密码写入 DSH 凭据存储（密码弹窗与
  添加/编辑主机向导里的「记住密码」默认勾选），之后包括 DSH 重启、后台重连与首次连接都自动使用，不再反复
  询问；取消勾选则只用于本次连接并清除已有记录。新增 `POST /hosts/:id/password`，添加主机时点「保存」而
  不连接也会记住密码。`HostView.passwordSaved` 在 Host 启动时从凭据存储恢复，`StateView` 增加
  `passwordStorageAvailable`，契约升到 **2.11**（只增字段）。

- **远端 DSH 关闭**：主机清单里已连接的卡片（以及在 `remote-unreachable` 错误状态上）新增「关闭远端 DSH」，
  与「重连」「重启远端 DSH」并列。它是破坏性操作，先弹确认框；确认后 Host 在同一条 SSH 会话上停掉**本连接
  绑定的那一个**远端 web 进程，然后关隧道、释放 SSH，主机落到 `disconnected`（配置与凭据保留，不会自动重连），
  之后点「重连」就能起一个全新的实例。停掉时复用重启的授权：run registry 命名该 pid、`/proc` starttime 仍是
  同一进程且 profile/home 一致；重挂接管的实例不会被自动或静默停止——显式关闭按当时记录的 `/proc` 身份只关
  那一个 pid（重启时它会并入冲突提示由用户选择）；`alongside` 保留的进程、pid 复用与无法证明归属的进程一律
  不杀（返回可解释的 `stop-unavailable`，409）。pid 已消失时只清理 registry、不发任何信号；`keepAlive:"stop"`
  也不会在收尾时补发第二次停止。
  `run/web.json` 随停止被清掉，下一次连接不会误弹「远端已有手工启动的 DSH」。API 契约升到 **2.9**：新增
  `POST /hosts/:id/stop-remote`、进度码 `stopping-remote` 与错误码 `stop-unavailable`。
- **远端 DSH 重启**：主机清单里已连接的卡片新增「重启远端 DSH」。Host 用同一条 SSH 会话停掉自己拉起的
  远端进程，重新 `npx` 启动、刷新 `run/web.json`、按新端口重建隧道并重新换 token；**不重跑** SSH / 探测 / 自举，
  不会再次索要密码或主机指纹。只有同时满足「run registry 命名」「本连接启动过」「`/proc` starttime 仍是同一
  进程且 profile/home 一致」才会 kill；重挂发现的 pid、pid 复用与 `alongside` 保留的进程一律不杀。冲突提示在
  kill 之前，取消不做任何破坏；动作内新建的隧道在取消/断开/删主机时关闭，不留持有已释放 SSH 的监听器。
- **远端自重启（插件市场更新等）自动恢复**：新增 `POST /hosts/:id/restart`、`remote-unreachable` SSE 事件
  （疑似 / 确认 / 恢复，带 15s 冷却）、`RemoteView.viewRev`（承载方据此重新导航）与 `remoteHeartbeat` 设置
  （默认 30s 可关，保存即生效）。同源代理与隧道不再把一次 `ECONNREFUSED` 当成进程重启；连续两次探活失败后
  才重读远端真实状态——候选必须能证明「同一 profile、同一 `~/.dsh`、端口属于该 pid，且最新就绪行给出 launch
  token」，`/proc` 进程扫描只用于解释失败；拿不到 token 不会假装重挂，而是报可解释的 `remote-unreachable` 并
  保留主机与配置。版本来自 npx pin 或被加载包的 `package.json`，证明不了就保持未知、不写进 registry。远端健康
  但隧道坏时重建本地监听器（先建新、再关旧；重建后 `viewRev` 自增让承载方重新 `open` 并导航，关闭旧 listener
  会短暂断开现有 WebSocket/下载，属预期），而不是误判进程重启。重挂发现的监听进程没有 kill 权，点「重启远端
  DSH」会先弹 stop/alongside/cancel 提示，用户选择前不会静默启动第二个实例。重挂期间显示 `restarting-remote`
  进度码而不是「连接断开」；诊断报告新增最近 10 次重启 / 重挂记录。
- **本地 LLM 会话能看到主机列表与连接状态**：Host 半端向 DSH 的 `tools` 服务注册一个**只读**工具
  `remote_hosts_list`，本地会话不必再让用户先去点主机条就能回答「我有几台主机 / 哪台连着 / 那台为什么失败」。
  参数只有 `includeDisconnected`（默认 true）；返回 `{ ok, hosts, count, connected, truncated? }`（最多 500 行，
  超出时带 `truncated`），每行是 `id` / 名字 / 状态 / 是否已连接 / 地址 / 最近一次失败 / 当前进度码 / 远端 DSH
  版本。返回值是**字段白名单投影**（再用 `redactText` 脱敏、按字段限长）：连接失败的原因原文里带的
  `SHA256:…` 主机指纹与密钥文件路径（`.ssh` 下路径，以及 `.pem` / `.key` / `.ppk` 或 `id_*` 命名的密钥文件）
  会分别替换成 `<fingerprint redacted>` / `<private-key path>`，因此结果里既没有密码、token、cookie，也没有
  指纹原文或私钥路径；`output.schema` 也声明为 `additionalProperties: false`，投影里多一个字段会让调用失败而
  不是漏出去。**维护主机仍然在主机条的「添加主机 / 管理界面」里**——工具没有写操作面（没有 add / update / remove / connect / disconnect），因此也不需要审批或
  确认门；它只注册在本地 Host 半端，远端 DSH 不加载本插件，远端会话看不到它。`tools` 是可选服务：注册走
  `ctx.inject`，宿主没有它时只少这一个工具，主机条与本地 API 照常工作，服务晚到或被替换时会重新注册。
- **浏览器端（`dsh web`）也能整窗打开远端界面**：没有桌面 guest 时，远端 UI 在**同源 iframe** 里呈现。
  本机 DSH 新增 `/dsh-remote-go/remote/<hostId>/` 反向代理：只服务已连接主机的回环隧道，去掉前缀后转发
  HTTP 与远端唯一的 WebSocket（`/api/remote.mux`，每主机一条精确升级路由），把 `Host`/`Origin` 改写为远端
  自己的回环 authority；远端的 session cookie 保存在 Host 侧 per-host jar，浏览器既拿不到远端 cookie，
  本地 cookie 也不会被转发出去。主机条与远端文件桥用同一份 `mountHostRow` / `mountGuestTools` 注入
  iframe（同源直接调用，不依赖 `unsafe-eval`），点「本地」仍走同一条意图通道。
- 客户端载体拆成 `desktop`（Chromium guest）与 `web`（同源 frame）两个后端，共用同一个窗口池、热窗口、
  切换、抢占与释放语义；`carrierSurface()` 是唯一的载体选择点。
- `GET /hosts/:id/open` 增加同源 `webUrl`；API 契约升到 **2.7**。桌面端继续只用回环 `url`，旧 Host 响应
  不会阻塞桌面路径。
- 测试：`remote-proxy` 单测（路径 / cookie jar / 同一源栅栏 / 头部与 Location 改写 / HTTP 与升级转发）；
  隔离 `dsh web` 的同源代理端到端（真实首页、插件资源、WebSocket 101）；真实浏览器的载体验收
  （iframe 里跑起真实远端页面、注入主机条、点「本地」回到本地）。

### 变更

- **「重连」「重启」也打开连接窗口**：两者和首次连接是同一种链路动作，现在都会浮出这台主机的连接窗口
  （阶段进度 + 连接日志），重启时标题是「正在重启「{name}」的远端 DSH…」。动作结束后窗口回到主机清单，
  关窗不中断连接；密码认证的重连先问密码，提交后再进入连接窗口。重启的宿主不必是当前填窗的那台。
- **卡片动作改名为「重启」「关闭」**：已连接主机的两个一次性动作不再带「远端 DSH」后缀（无障碍名仍保留全称
  「重启远端 DSH」/「关闭远端 DSH」），进度文案同步缩短为「正在重启…」/「正在关闭…」；「关闭」的确认框精简为
  标题 + 一行说明（会停止远端进程并断开连接，配置与凭据保留，可随时重连）。错误页里的建议改成卡片上的实际按钮名。

### 修复

- **保存的 SSH 密码从未真正落进 DSH 凭据存储**：记录键此前是冒号分隔的
  `dsh-remote-go:ssh-password:h_xxx`，DSH 只接受 `<owner>/<id>` 形式，写进去虽然成功，但下一次读取整个
  `.credentials.yaml` 时会拒绝这条记录（连其它插件的凭据一起失效）。改为 `dsh-remote-go/ssh-password-h-xxx`
  并补上键格式单测；同时修复删除主机、改用密钥认证后密码记录残留的问题。
- **「关闭」确认框不再让窗口看似卡死**。关闭确认渲染在管理窗口内部，而对话框栈给「非栈顶」层级加 `inert`
  时，嵌套在其中的确认框被一起禁用：确认 / 取消 / 遮罩都不再接收点击和焦点，整个窗口像冻住（只有 Escape
  还能退出）。现在承载栈顶对话框的层级保持可用（下层仍由栈顶自己的遮罩挡住），并补上对话框栈的嵌套单测与
  浏览器回归（命中测试 + 确认后确实发出 `POST /stop-remote`）。
- **对话框：一次 Escape 只关栈顶**。所有对话框改走单一「模态栈」：一个 document 级监听按栈顶分发
  Escape 与 Tab，不再每个 `Modal` 各自挂监听（旧实现依赖每次渲染都变的 `onClose`，重挂监听时一次按键
  会先关掉下层）。同时补上初始焦点、Tab 循环、卸载还原焦点、`overflow:hidden` 滚动锁、仅栈顶
  `aria-modal`、下层 `inert`、标题 `aria-labelledby`；输入框恢复 `:focus-visible` 外环。动作进行中的
  对话框不可被 Escape/遮罩/头部 × 关闭（× 同时 disabled）。
- **编辑主机不再静默改端口 / 把 IPv6 读成端口 1**。`HostView` 新增非敏感的 `port` / `username`，编辑
  表单直接读取；`addressMasked` 只用于展示（端口 22 省略、IPv6 加方括号）并补跨端一致性测试。
- **`/state` 增加单调 `rev` 与发布代际 `instance`，旧帧不再回退界面**。Host 每次发布状态时自增 `rev`；
  Client 只接受更新的帧，迟到的 `GET /state` 响应低于当前 revision 即丢弃；Host 重启/插件重载换
  `instance`，新代际的帧即使 `rev` 回退也会被接受，不会永久卡在旧高水位。契约升到 **2.10**（只增字段，
  向后兼容）。
- **SSE 断开后自动重连并明确降级**。状态流按指数退避重建 EventSource（最多 8 次，之后停在轮询并保留手动
  「重新连接」）；只有真正收到 `open`/首帧才恢复 live，重连期间横幅保持可见，期间以 3s 轮询兜底；主机清单
  页脚与宿主 toast 同时提示降级/恢复，轮询期间继续补下载任务状态。
- **密码流程**：编辑密码主机而没改认证方式时不再要求输入密码（文案说明连接时会再询问）；`passwordSaved`
  为真时先尝试无密码连接、失败再弹窗；密码框在请求进行中禁用输入与回车，避免一次 Enter 发两次
  `POST /connect`。
- **表单校验落到字段**：校验返回 `{field, code}`，`Field` 显示字段错误并设置 `aria-invalid` /
  `aria-describedby`，焦点移到第一个错误字段，字段一改即清除；前端与 Host 使用同一组范围（端口、连接
  超时、idle 分钟、重试次数/间隔、profile），`profile: desktop` 在前端直接拒绝。
- **401/403 不再显示「插件内部错误」**：DSH 准入返回的非 JSON 401/403 分别映射为「会话已失效，请刷新」
  与「被安全策略拒绝（Host/Origin）」，`retryable:false`。
- **管理界面**：正在连接的主机不进清单（重启/关闭这类一次性动作的卡片保留，但连接中禁用编辑/删除）；
  删除连接中的主机需二次确认；卡片与连接窗口渲染 `warning` 与版本差异提示；下载卡改为不含按钮的
  live region，进度条带 `aria-label` / `aria-valuetext`；toast 支持 `warn`/`info` 强调色、队列与
  `aria-live`；11px 元信息改用 `label-secondary` 并纳入对比度门禁（≥4.5:1）。
- **载体交互**：浏览器载体的下载桥统一补上 carrier 的 `hostId`（guest 自带 hostId 不能伪造），guest
  intent 在收口处做 action 白名单与 hostId 强制覆盖（guest 行只投影本地 + 自己的主机，断开其他主机直接
  拒绝）；失败层增加「返回本地」按钮与 `role="alert"`，浏览器载体检测到「文档不是 DSH」或 10s 未
  load 时都显示该层；主机条支持键盘（Tab/Enter/Space/方向键/Escape/roving tabindex）；`wanted` 竞态在
  所有分支统一检查；主机条/能力桥注入失败按 1.5s 起退避重试（桌面与浏览器载体都接）；`executeJavaScript`
  失败与 intent drain 超时不再静默卡死；`localStorage` 分区不可被 `delete` 绕过；`findSlot`、重装幂等、
  `readStart` 单位、`disposeCarrier` 清理 launch URL 等低危项一并修正。审计来源见 PR #63。

- **连接链路的一组生命周期缺陷**（独立审计 B1 / H1–H4 / M1–M6，均带复现）：
  - **跳板机与目标机的指纹串台**：过去跳板与目标共用同一份 host-key 上下文（策略、pin、确认回调），
    在「跳板 + 首次确认」后会把自己的公钥写成**目标的** `pinnedFingerprint`，之后再连就是永久
    `host-key-changed`（不可重试），目标已有 pin 时第一个跳板连接就报 `host-key-changed`。现在两者各有独立的
    上下文：跳板只受全局策略约束、pin 只记在本次会话（`runtime.jumpFingerprint`），确认跳板**绝不**写目标
    记录；确认提示的进度帧对跳板带 `role: "jump"` 与地址，目标帧形状不变（见 [docs/api.md](docs/api.md)）。
  - **`idle` 存活策略永远停不掉远端、又会误杀刚接回来的链路**：teardown 清空 `facts` 后，空闲计时器用一个
    字面量 `~` 路径拼命令，`kill -0` 变成 no-op 却仍报成功；而新的连接不会取消旧计时器，到点后会把用户刚连上的
    链路停掉并留下「状态 connected、SSH/隧道已空」的僵尸态。现在：任何一次连接与每次成功挂载都会取消空闲计时器；
    计时器触发时若主机已连接（`desired`/`status`/隧道任一）直接返回 `still-wanted` 且不释放 SSH；停机前先按
    `/proc` 身份（starttime / DSH home / profile）证明那个 pid 仍是本连接启动的那个，pid 复用或无法证明归属时
    不发信号；idle 保留的旧 SSH 在下一次连接开始时先释放。teardown 先记住真实 `remoteHome` / `remotePid`，
    `remoteLayout(null)` 直接拒绝而不是造 `~`，`stopRemoteWeb` 既无 pid 也无 registry 时返回 `no-target`
    （不再假装停过）。
  - **失败启动的清理会误停别的进程**：`startRemoteWeb` 失败后改用「本次启动脚本打印的 pid」停止，且先确认它
    仍存活；不再回退到 `run/web.json` 里的 pid——那份记录可能属于重挂接管、本插件没有启动过的实例。停止脚本
    也只在记录确实命名被停的那个 pid 时才删除 registry。
  - **跳板 pin 不按跳板身份区分**：`runtime.jumpFingerprint` 现在带 `host`/`port`，只在同一跳板（含端口）时
    使用；改了主机的 `jumpHost` 会丢弃旧 pin 并重新询问，而不是把新跳板报成 `host-key-changed`。
  - **`autoReconnect.maxAttempts` 只重试一次**：每次进入管线都把计数清零，预算判定成了死代码。现在只有
    「用户手动连接」与「连接成功」会归零，重试由失败统一排下一次；用户在选择框点「取消/拒绝」或首次连接
    根本没建立起链路时不再自动重试。
  - **连接期间断线被报成 `internal` 且不重连**：断线监听只在 `connected` 之后才装，`exec`/`openSftp`/
    `forwardOut` 在关闭的连接上抛裸 `Error`。现在 SSH 会话一建立就装上监听（握手期也监听，握手期断开会让
    挂起的指纹提示立即结算并按网络错误拒绝，而不是干等到超时），关闭的连接返回
    `network`（`reason=ssh-closed`），bootstrap 期间断线按网络失败处理并进入重连。DNS 解析失败这类
    **同步 error+close** 只算一次失败，不会被当成断线去重试一条从未建立的连接。
  - **用户操作与管线无互斥**：每个 `await` 之后都复查「用户还要这条连接吗」（`desired`/`closing`/`disposed`/
    主机仍在），隧道端口改用局部变量并校验，disconnect / 删除主机不会再收到假的 `connected` 帧，
    也不会再在 `runtime.tunnel.localPort` 上空指针崩溃；`removeHost` 先置 `desired: "idle"` 并清 `activeHostId`。
  - **指纹提示期间断开**：teardown 现在会以 `false` 结束挂起的确认并清 `pendingHostKey`（不再占住
    connectPromise 到 120s 超时），超时同样清理，确认只在 `fingerprint-pending` 期间被接受。
  - **远端 `web.log` 里的 token 被默认 umask 落盘**：启动脚本开头 `umask 077` 并 `chmod 600` 日志；
    `profile-dump.yml` 用完即删。
  - **`run/web.json` 非原子写 / 停止失败也删 registry**：改为临时文件 + `mv`，停止未确认时保留记录，
    registry 读不出来时仍能从中恢复 pid（不再误判为「没有记录」），且 pid 必须由 `,`/`}` 结束才算数。
  - **`known_hosts` 的明文条目对任意端口作保**：非 22 端口现在只认 `[host]:port`（与 OpenSSH 一致）。
    已知限制：`!host` 否定行与 `|1|` 哈希行不支持；否定行被当成普通模式，因此带否定的条目比 OpenSSH
    **更宽松**（不是更严格），详见 [docs/design.md](docs/design.md) §5.3。
  - **文件夹下载在大小写不敏感的文件系统静默覆盖**：同名（仅大小写不同）的远端文件按 `name (2).ext`
    改名，两者都落盘（大小写不敏感判定在 Windows/macOS 默认开启）；`desktop.ini` / `thumbs.db` / `*.lnk` /
    `*.url` 等 Windows 元数据与快捷方式只在 **Windows 本地**被跳过，被跳过的名字通过下载任务的
    `ignoredNames` 透出，其他平台照常下载。
  - 另有若干低危加固：`shutdownAll` 先置关闭标志再收尾、重连计时器 `unref()`、`exec` 的进度回调抛错不再
    中断命令、探测/预检超时按网络条件分类、关闭隧道时销毁已建立的 SSH 通道、读取私钥前限制大小。
- **连接日志每次连接都从干净的一页开始**：手动重连与断线自动重连会清空上一次连接的日志与序号，并先写一条
  带次数与时间的边界行（`— 第 N 次连接 · 时刻 —`），面板默认只显示本次连接；每行还带写下它时所在的阶段，
  行首显示阶段标签。修掉重连后旧行仍挂着、分不清哪行属于哪次连接的问题。API 契约升到 **2.8**：
  `ConnectLogEntry` 新增可选 `phase` / `text` / `boundary`，`logs` 改为每次连接重置。
- **连接失败时日志自己就能说明问题**：失败不再是一行「错误码 + 原始报错」，而是按顺序写出失败阶段与错误码、
  与错误卡片一致的中英双语原因、每一条下一步建议，以及脱敏（`src/redact.js`）并用 `headTail` 截断的技术
  细节；`remote-dsh-start-failed` 会把远端日志尾部逐行打印，所有失败行用 `error` 级别渲染。
- **浏览器端远端界面里的复制、外链、登录弹窗与偏好存储**：同源 iframe 的页面拿不到只有顶层文档才有的浏览器能力，
  过去表现为「复制无反应、无提示」「点网页链接没反应」「登录弹窗被拦」「本地与远端共用一份 `localStorage`」。
  现在注入一个能力桥，把这三类请求经既有 intent 通道交给本地页面执行：外链（`a[href]` 点击与 `window.open`）
  在顶层以新标签页打开、只放行 http(s)（`ctrl/cmd/shift/alt` 与中键仍交浏览器默认）、clipboard 写入由本地页面执行
  并把结果回执给前端（成功置 ✓、失败弹「复制失败」提示，不再静默）、提示复用浮层 toast；frame 的 `allow` 补上
  `microphone` / `fullscreen` / `popups`，登录用的 `about:blank` 弹窗可以打开，语音输入可以请求麦克风。
  远端页面的 `localStorage` 在桥注入后按主机分成 `drg:<hostId>:` 命名空间，远端与本地不再互相覆盖对方写入的键。
  已知边界：`popups` 同时让远端页面自己的 `a[target=_blank]` 可以原生开任意 URL（绕过桥的白名单），所以白名单是
  UX 护栏、不是对远端页面的隔离边界（信任前提是「远端页面=用户自己连的那台 DSH」）；存储分区从注入之后生效，
  **首次加载/重载启动时仍读共享 store**，且 `sessionStorage` / cookie / IndexedDB 未隔离；OAuth 回调能否走通取决于
  远端页面自己的流程；桌面端 guest 的 `setWindowOpenHandler` 在 DSH 桌面主进程里，插件改不到，桌面路径复用同一条桥
  （桌面壳若不允许新窗口，链接就只会在那儿被丢掉，桥拿不到可判定的失败信号）。
- **远端窗口收起侧边栏后，标题栏的「新建会话」不再压住「应用」**：桌面端 guest 按桌面栅格排版，
  侧边栏收成 rail 后它把「新建会话」固定在标题栏 48px 处，而宿主的标题栏菜单（「应用」「编辑」）
  默认也从 48px 起——本地页不知道远端的 rail 状态，于是两者叠在一起（#63）。现在 guest 在每次
  装载时、以及每次折叠 / 展开后，经同一条桥队列上报 rail 状态和它自己解析出的菜单起点，宿主据此
  在**84px（收起）/ 48px（展开）** 之间切换，回本地页时把这个覆盖删掉、交还本地侧边栏自己的规则。
  展开与收起两种状态下的顶部间距都与本地窗口一致；切换瞬间（最多一个 400ms 轮询周期）仍会短暂
  重叠一下再归位。

### 安全

- **`ErrorView` 统一脱敏并限长**（独立安全审计 A）。失败连接会把远端进程输出塞进 `ErrorView.technical`，
  而远端 `web.log` 的第一行就是带会话 token 的 launch URL。错误视图此前没有脱敏；连接日志此前也没有——
  `remote-web.js` 的 `onLine` 把同一行写进连接 ring，`HostView.logs`、SSE 状态帧与诊断导出都读它，所以
  **成功连接进行中**的 `/state` / `/events` 就带 token。现在两处都封住：`toErrorView` 在返回前跑
  `redactObject`（`technical` / `detail` / `nextSteps` 里的 token、`Authorization`、cookie、私钥与家目录
  全部替换，`technical` 与单条日志都截断到 1200 个字符），`appendConnectLog` 在写入 ring 时先 `redactText`。
  `redactText` 同时补上裸 `token=`/`#token=`、`x-*-token` 头与
  `/Users/` 路径，并且不再把 `ssh -p 2222` 的端口当成密码脱掉。
- **同源栅栏按回环等价比较 `Origin`**（审计 B）。本地 API 用字符串比较 `Origin` 与内核给的
  `127.0.0.1:<port>`，用 `localhost` 打开 GUI 时 `/state`、`/health`、`/events` 全 403，表现为「能读不能写」。
  改用 `request-trust.js` 的 `sameServerOrigin`：`127.0.0.1` / `localhost` / `[::1]` 与默认端口折算视为同一
  origin，外部域、其它端口、其它协议仍然拒绝；`Origin` 的 authority 按原样（大小写不敏感）比较，
  `user@host`、尾点、补零端口这类被解析器改写的值不会被当成回环。
- **同源代理收紧为双向白名单**（审计 C）。请求头从黑名单改成白名单，本机会话的 `authorization`、`cookie`、
  `x-dsh-*`、`forwarded` / `x-forwarded-*`、`sec-fetch-*` 不再发给远端（只有 `accept*` / `content-*` /
  `range` / `if-*` / `cache-control` / `user-agent` / `x-requested-with` 与 WebSocket 握手头通过）；响应头按名
  丢弃 `clear-site-data`、`access-control-*`、`refresh`、`content-location`、`report-to`、`nel`、
  `permissions-policy`、`alt-svc`，远端不能再借此清本机 cookie 或改写浏览器策略；`Location` 只折回远端自身
  listener，其它绝对地址（外部域、`//host`、含反斜杠的「相对」引用如 `/\evil`、其它 loopback 端口）直接
  丢弃；上游 30s 无响应即 502 并销毁两侧；**WebSocket 的 101 响应头也过同一套策略**（此前原样透传，
  `Set-Cookie` / 策略头可借握手绕过）；`accept-encoding` 作为内容协商头转发；per-host cookie jar 限 64 条 /
  值 4 KiB，`Secure` cookie 不进明文 jar。
- **数据层不再静默丢配置**（审计 D）。`hosts.json` / `settings.json` / `secrets.json` **内容不可解析**时
  先改名为 `<name>.corrupt-<stamp>` 再回落到默认值，避免下一次写入把全部主机（含 pinned 指纹）永久覆盖；只是
  读不了（EACCES/IO）的文件只回落、不改名，避免把权限问题变成空主机列表。损坏标记通过
  `StateView.storeCorrupt` / `HostView.storeCorrupt` 与 `/diagnostics/self` 暴露，并在下一次成功写回后清除
  （不会永远提示）。`POST /settings` 改为与
  **当前值**深合并（嵌套 patch 不再把 `autoReconnect.baseDelayMs` 从 5000 重置成 800）；`saveToken` 先
  `load()`，不会再以 `{}` 覆盖已有 secrets。
- **下载目标加固**（审计 F）。`POST /downloads` 的 `destination` 只允许本机用户主目录之下，并拒绝
  `Startup` / `autostart` / `systemd` / `Start Menu\Programs` 等自启动位置、macOS 的
  `Library/LaunchAgents` / `LaunchDaemons` / `StartupItems`、`.ssh` / `.gnupg` 等凭据目录、
  `.bashrc` / `.profile` / `.zshrc` / `.xsessionrc` / `.config` / `.local` 等登录脚本与配置目录、系统目录与
  `shell:startup` 一类路径（Windows / macOS 的路径比较按大小写不敏感处理）；校验是同步的（坏路径直接 400，
  不再先建 `preparing` 任务再异步报错），并且 API 预检与写入用**同一个 home 根**（job 携带 `home`，不再回落到
  `os.homedir()`）。**远端命名的最终路径同样
  过关**：`destination=~/.config` + 远端文件夹名 `autostart`、`~` + 远端文件名 `.bash_login`，以及会在其下
  生成受保护路径的上级目录都在创建前被拒绝（零写入）。主机 `id` 只由 Host 签发（客户端传来的未知/畸形 id
  一律替换成新的 `h_*`）；`POST /local-version` 只在探测失败时接受回填、不得低于 `engines.dsh` 下限，格式
  不合法返回 400。
- **错误与契约修正**（审计 E）。`internal` 由 409 改为 500；畸形主机 id 与越界的 `keyfile/list` 由 500 改为
  400 `invalid-input`（且不回显路径）；>1 MiB 请求体先回 413 JSON 再结束，不再让客户端看到 `ECONNRESET`；
  SSE 限 8 个客户端、慢消费者与超大帧有上限；`/health` 收敛为 `{ "ok": true }`；`/diagnostics/self` 的
  `home` / `stateDir` 脱敏。
- **本地 HTTP API 与同源代理补上 DSH 的 Host/Origin 准入**（#65）。每条请求在进入路由前先过本机 DSH 自己的
  `ctx.connection.requestRejection`：Host/Origin 栅栏 + 浏览器会话认证，与 DSH 自带路由同一套检查；服务不存在
  的旧内核退回本插件原本的标识头 / 同源栅栏，升级后仍可用。此前 API 只看 `Origin` 与 `sec-fetch-site`，
  不看 `Host`——DNS rebinding 下攻击页与被 rebind 的主机名同源，请求没有 `Origin`、`Sec-Fetch-Site` 是
  `same-origin`、`Host` 是攻击者域名，`GET /dsh-remote-go/api/events` 这条只走 Origin 栅栏的 SSE 状态流
  （主机清单、状态、诊断字段）可被读走。现在：
  - API 与代理共用 `request-trust.js` 的同一份 Host/Origin 栅栏；`Host` 必须是本机 origin，`/events` 同样受检。
  - 没有浏览器会话的调用方（包括只带 `x-dsh-remote-go` 标识头的直连）在 `/events` 与普通 JSON 路由上一律
    401/403，拒绝发生在 SSE 开流之前与代理建立上游连接之前。
  - `GET /health` 仍无需浏览器会话（存活探针，不返回状态数据），但同样过 Host/Origin 栅栏；API 契约见
    [docs/api.md](docs/api.md)。

### 构建 / CI

- **集成套件登记守卫与统一门禁入口**：`check-repo` 枚举 `test/integration/*.test.js` / `*.e2e.js`，凡是既不在
  `test:integration:local`、也不在 `test:integration:external` 里（且不在 acceptance 白名单 `desktop.e2e.js`）的
  套件直接失败并提示该加到哪里；CI 的 `Verify` 与 `release` 都真正执行同一个 `pnpm run gate`，以后只往 gate
  加检查时 CI 不会漏跑。E2E 的就绪等待统一走 `harness-support.js` 的 `waitFor`（定时轮询，避免后台页暂停
  requestAnimationFrame 造成的假超时）。
- **PR 上的端到端测试不再静默跳过**：`ci.yml` 把集成测试拆成「无外部依赖」（模拟远端、重启、关闭远端）与
  「需 harness / 浏览器」（同源代理、`dsh web`、浏览器载体、guest 工具、关闭远端的浏览器流程）两组，清单放在
  `package.json` 的 `test:integration:local` / `test:integration:external`，CI 与 release 共用；后者安装按
  `engines.dsh` 解析出的 DSH harness 与 Chrome，并在 `DSH_E2E_STRICT=1` 下运行。`release.yml` 也安装同一套
  harness/Chrome，跑 `pnpm run gate` + 两组严格集成，不再比 PR 门禁宽松；桌面端 E2E 需要真实 Electron 安装包，
  仍在夜间 `acceptance.yml` 运行，该任务同时补跑浏览器载体套件。Windows 任务补上规范 / 格式 / 语法 / workflow 检查。
- **发布门禁补上 vendor 与版本一致性**：`pack:check` / `check-repo` / `market:check` 把
  `vendor/ssh2.bundle.cjs` 与 `vendor/THIRD_PARTY_NOTICES.md`（以及 tarball 里的 vendor 运行时）列为必需项，
  构建输入 `vendor/ssh2-entry.mjs` 明确不进 tarball；CI、release 与 `prepack` 用 `pnpm run build:vendor` +
  `git diff --exit-code -- vendor/` 确认重建字节一致；`check-repo` 校验 `src/constants.js#PLUGIN_VERSION`
  （行首真实声明，注释不参与）与 `package.json#version` 相等；`acceptance.yml` 的 harness 版本改为从
  `engines.dsh` 读取（不低于 `0.2.2-rc.3`）；`vendor/THIRD_PARTY_NOTICES.md` 的 MIT 正文直接取自
  `node_modules/ssh2/LICENSE`；市场条目 `--check` 对整对象比对，并单独校验 `plugin-entry` 与 `index` 两处
  `publishTimestamp` 的存在与类型。
- **覆盖率不再有盲区**：`client.js` 以绝对文件名载入 vm，从而进入覆盖率报告（此前完全不计入）；
  `test:coverage` 改为 `scripts/check-coverage.mjs`，保留 `src/` 聚合阈值并为 `client.js`、
  `src/local-ssh.js`、`src/local-download.js` 设 per-file 下限（单测失败与覆盖率不达标分别报错）；补
  `local-ssh` / `local-download` 单测。
- **仓库卫生**：脚本的仓库根改用 `fileURLToPath`（含空格的路径不再算错）；单测不再泄漏临时目录；
  语法检查覆盖 `e2e/`，workflow 检查自动发现全部 YAML，秘密扫描扩到 `docs/` / `test/` / `e2e/`；
  市场条目改为整对象比对（仅豁免生成时刻的 `publishTimestamp`）；fake-remote 删掉已不存在的
  `readRemoteFile` 并加「fake 方法集 ⊆ real 方法集」守卫；CI job 加 30 分钟超时；补提交可选的
  `.githooks/pre-commit`。

## [0.1.0] - 2026-11-16

首个版本：在本地 DSH 里通过 SSH 使用远端 DSH，整窗呈现远端界面，本地只负责连接与状态。

### 新增

- **远端文件与文件夹下载**：在远端 DSH 的 Files 面板右键文件 →「下载」，或右键文件夹 →「下载到本地」。
  点击后选择本机保存目录，Host 在自己的 SSH 连接上经 SFTP **流式写入本地**，不在内存缓存文件字节。
  文件写入 `<目录>/<文件名>`，文件夹新建同名目录后逐个文件写入；同名文件/文件夹自动加 ` (2)`。
  **不设置文件大小、文件夹总字节或文件数量上限，不打包 ZIP、不写远端磁盘。** 下载以 Host 侧任务运行，
  SSE 推送字节/文件进度，右下角显示可拖动的确定进度条并可取消；取消会清理本次未完成的文件/目录。
- **下载任务 API**：新增 `POST /downloads`、`GET /downloads/:id/status`、`DELETE /downloads/:id`
  与 SSE `download` 事件；所有下载都由 Host 流式写入本地目录，不再提供二进制下载端点
  `GET /hosts/:id/file` / `GET /downloads/:id`。API 升到 **2.6**，新增 `download-not-ready` /
  `download-busy` 错误码。
- **连接窗口**：上半是分阶段进度（指纹确认 / 错误卡片），下半是逐行连接日志（SSH 目标与指纹、托管 Node
  下载、`npx` 取包、远端启动、隧道、界面校验），最多 120 行、随 `/state` 下发；关窗不中断连接，连上后
  自动闭合并接管整窗。
- **私钥浏览与密码保存**：`GET /keyfile/list` +「选择文件…」弹窗，只读且限制在用户主目录内（拒绝 `..`
  与符号链接逃逸）；勾选保存的 SSH 密码写入 DSH 凭据存储，`hosts.json` 永不保存密码。
- **诊断**：固定 10 项检查（含「远端 Node 运行时」），托管 Node 安装失败新增错误 `remote-node-install-failed`。

### 变更

- **本地切远端不再闪一下**：被隐藏的远端窗口没有可用的 guest surface，过去一显示就先画出 carrier
  自己的底色（热窗口一帧，冷窗口是整个页面加载期）。现在窗口先透明挂上，等远端页面提交并画出帧后才
  变为不透明；等待期间仍显示本地页面（也仍可点击），中途切走则这次显示作废。远端切本地本来就没有空白帧。
- **编辑主机时预填已保存的私钥路径**：`HostView` 新增 `authKeyPath`，编辑表单不再要求重新选一次密钥文件；
  没有改动认证时留空也能保存（保留原值）。
- **默认私钥路径改为 `~/.ssh/id_rsa`**：向导预填更通用的默认名；配置的路径不存在时，仍按
  `id_ed25519 → id_rsa → id_ecdsa` 的顺序兜底。
- **主机条成为唯一入口**：本地与远端页面顶部各一条，列出「本地」与每台主机；已连接显示绿点、悬停出现
  「断开」，切回已打开的远端不重新加载；删除侧边栏入口、主面板与设置页入口。
- **整窗接管**：桌面端以 Chromium guest 铺满窗口，远端页面让出标题栏一条（失败时整体下移）；删除内嵌 /
  浮层 / 独立窗口形态、iframe 沙箱与相关设置和文案，每台主机一个热窗口。
- **托管 Node**：连接总用插件自己的 Node（版本 = 本机 `engines.node` 下限），官方 tarball + SHA-256 校验，
  官方源不可达回退 npmmirror，**没有系统 Node 兜底**；`bootstrap` 设置收敛为 `{ profile }`。
- **SSH 认证**只剩「私钥文件」与「密码」（移除 Agent 通道），新增 `defaultKeyPath`，密钥路径按用户主目录展开。
- **移除镜像 / 会话子系统**（含镜像、租约、历史回放、工作区注册），API 契约升到 **2.0**；随后连接日志
  相关契约升到 **2.2**，移除未使用的 `POST /hosts/:id/password` 与 `/keepalive`。
- **最低 DSH 版本提高到 `0.2.2-rc.3`**：界面只注册在 `shell.overlay`，只在验证过的版本上启用。
- **界面按 DSH 主题重做**：颜色、圆角、阴影与字体直接读取 `--dsw-*`（无本地 token 层、无颜色字面量），
  尊重「减少动态效果」「增强对比度」「强制颜色」，第三方主题与 `overrideTokens()` 覆盖即时生效。
- **文档与市场条目**同步为「托管 Node + npx、无镜像子系统」的当前行为，删除过期设计文档。

### 修复

- 断开后主机条仍显示远端名：按实时目标收尾，释放正在显示的远端窗口时回落到「本地」。
- 主题与配色：主机条光标、状态点与「断开」按钮的错误变量、主按钮文字配色、对话框/下拉菜单底色。
- 向导步骤、诊断列表、抽屉与设置分区样式缺失（未闭合 CSS 注释吞掉规则），并新增注释闭合与选择器守卫。
- 连接期间的 SSH 错误不再导致 Host 崩溃；修复 CI 在干净 runner 上校验 workflow YAML 的问题。

### 安全

- **零运行时依赖 + 无安装期脚本**：`ssh2` 预打包进 `vendor/` 随包分发，安装不拉取依赖、不执行第三方代码。
- **回环硬规则**：远端与本地隧道都只监听 `127.0.0.1`，guest 只接受回环地址。
- **凭据最小化**：密码默认只在内存，保存时进 DSH 凭据存储；launch token 默认只在内存，落盘时 0600；
  本地状态目录 0700、文件 0600 且原子写。
- **主机指纹**：首次确认、接受后记录、变化阻断，`strict` 策略拒绝未记录的主机。
- **本地 API 鉴权**：自定义请求头 + 同源 `Origin`，拒绝跨站 `sec-fetch-site`；跨站请求一律 403。
- **发布物与自举白名单**：tarball 只含运行时文件、无生命周期脚本；Node 下载、`npx` 版本与远端启动都走固定
  命令模板，下载校验 SHA-256。
- **脱敏**：诊断导出默认屏蔽 token、密码、私钥与家目录。

[Unreleased]: https://github.com/Solaris136/dsh-remote-go/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Solaris136/dsh-remote-go/releases/tag/v0.2.0
[0.1.0]: https://github.com/Solaris136/dsh-remote-go/releases/tag/v0.1.0
