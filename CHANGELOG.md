# Changelog

> **English abstract.** Notable, user-visible changes to `dsh-remote-go`, newest first. The format follows
> Keep a Changelog 1.1.0 and versions follow Semantic Versioning 2.0.0; entries are written in Chinese and
> describe behavior rather than individual commits.

本文件记录用户可感知的变更，格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)，日期为 `YYYY-MM-DD`。

## [Unreleased]

### 安全

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

### 新增

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
  但隧道坏时重建本地监听器，而不是误判进程重启。重挂期间显示 `restarting-remote` 进度码而不是「连接断开」；
  诊断报告新增最近 10 次重启 / 重挂记录。
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

### 修复

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

[Unreleased]: https://github.com/Solaris136/dsh-remote-go/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Solaris136/dsh-remote-go/releases/tag/v0.1.0
