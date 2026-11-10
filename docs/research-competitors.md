# DSH 远程类插件 · 同类项目调研与需求/注意点总结

> 调研时间：2026-11-10 · 面向项目：`dsh-remote-go`（DSH 远程入口，薄客户端方案）
> 方法：GitHub README/源码 + npm registry + 本地 clone（`_research/vendor/dsh-remote-gui`、`_design/research/incoming/`）。
> 目的：从同类项目提取**需求**与**踩坑点**，反哺我们自己的设计，不评价项目优劣。

---

## 0. 结论速览

1. **方向被验证**：至少 8 个 DSH 生态项目在做「在本地用远端 DSH」。其中 **dsh-remote-dsh** 已实现「整页接管远端 Web GUI」（本地回环 + iframe），**dsh-remote-gui** 实现「本地原生面板 + 远端会话」——两者证明「本地只做呈现」在 DSH 里可行。
2. **最接近的组合已经有了，但不是「零远端组件」**：`graydovee/dsh-remote-window` 已实现「本地主区全屏同源 iframe + 远端官方 UI + 双模型来源」，并用同源 portal 解决 iframe cookie；代价是远端要 per-client profile + 专属插件 + 独立 runtime。我们的差异化因此收窄为：**零远端专属组件、部署更轻、多机体验更好**。多数其它项目仍是「浏览器打开」或「本地重写会话 UI」。
3. **最大的硬约束是回环**：远端 DSH 的会话 cookie 是 `HttpOnly; SameSite=Strict`（硬编码），跨 site 的 iframe 连 `index.html` 都会 401。必须把远端映射成本机 `127.0.0.1:<端口>`（ssh -L 或 frpc stcp/xtcp visitor）；Tailscale IP、公网域名都不行。
4. **最大的未验证点是 iframe 的 cookie 种入/持久化**：`dsh-remote-gui` 文档明确把它列为「整条链路唯一的架构性未知」，并在后续版本**放弃 iframe 改为原生面板**。我们的 V1 设计必须把它作为**第一道可行性闸门（V0）**，并准备「外部窗口打开」降级方案。
5. **成熟项目都在补运维细节**：SSH 别名自动发现、远端 Node/DSH 探测与一键安装（不需要 root）、systemd user unit / 端口注册表、隧道看门狗与收养、token+cookie 缓存与 401 刷新、诊断导出脱敏、退出时「保持远端运行/停止远端」、通知——这些应进入我们的需求清单，而不是等二期。

---

## 1. 项目地图（同类项目）

| 项目 | 形态 | 传输 | 远端依赖 | 亮点 | 主要限制 | 版本/热度/更新 |
|---|---|---|---|---|---|---|
| **dsh-remote-window**（graydovee，最接近） | 本地 web 插件：浮动 target rail + **主区全屏同源 iframe** 显示远端 profile 的官方 DSH UI | SSH（ssh2）；profile server 绑回环 | 每个 client 一个专用 DSH profile + server 插件 + 独立 Node/DSH runtime | 同源 portal 反代解决 iframe cookie；server 权威数据；双模型来源（本机自动代理 / server）；host key pin；lease/writer 仲裁；runtime 兼容矩阵 | alpha、真实主机 E2E 待跑、远端重、文档漂移、0★、未进市场 | 0.1.0-alpha.6 · 2026-11-09 |
| **dsh-remote-dsh** | 侧栏「远程」行 → **整页接管**远端 DSH Web GUI（iframe） | SSH -L（或 frpc stcp/xtcp visitor） | 远端 `dsh web` + 可选 peer 插件（状态点） | 整页体验最接近「就是那台 DSH」；明确记录回环硬规则；状态点（琥珀=等回答/蓝=运行/绿=新活动/红=读不到）；远端桌面功能配置清单 | 接管时盖住本地侧栏；iframe 获焦后 Esc 失效；无 agent 集成；宿主半边改动需重启 | v0.1.1 · 2★ · 2026-09-11 |
| **dsh-remote-gui** | 侧栏页脚 + **原生中心面板**（列远端会话、读正文、发消息、新建、归档） | SSH -L + token→cookie 兑换 | 远端 `dsh web`（systemd user unit 名为 `dsh-web`） | 隧道看门狗/收养、token+cookie 缓存与 401 刷新、回环围栏、原生面板、会话折叠、两步确认、MIT | 早期版本用 iframe，HEAD **已改为原生面板（无 iframe）**；无流式（3s 轮询）；token 依赖固定 unit 名；文档与代码有漂移 | v0.1.3 · 1★ · 2026-11-01 |
| **dsh-remote-tunnel** | CLI profile + 右侧栏 **Browser 面板**打开远端 dsh web + `/remote` 命令卡 + 状态条 | SSH -L | 远端 Linux + Node≥24.9 + dsh + systemd（user 级别即可） | 远端端口分配 + 共享注册表（多用户需 root 一次性建组/文件）、systemd unit、bootstrap/check/status/audit、自动发现 `~/.ssh/config` 与 `known_hosts`（哈希条目跳过）、两步确认 | 需要 systemd；共享服务器多用户配置复杂；命令卡/状态条在空会话不渲染（侧栏面板才是保底入口） | v0.2.2 · 6★ · 2026-11-05 |
| **dsh-remote-explorer** | CLI 长驻 + 本地插件；provision 后**跳浏览器**打开远端 dsh web | SSH forward + reverse 凭据隧道 | 远端 Linux/macOS + Node/DSH/pnpm（自动安装，无需 root） | **凭据不出本机**（反向隧道代理，多 provider 路由，per-session token，占位 token）；磁盘隔离仿 VS Code（`~/.dsh-remote-explorer`，不写远端 `~/.dsh`）；多用户模型；远端插件由远端管理；GitHub 代理注入；离线包 | 界面是浏览器跳转（非本地嵌入）；本地面板刻意不做插件管理；同账号共享 session 根 | v0.8.10 · 7★ · 2026-11-04 · Apache-2.0 |
| **dsh-remote-local-plugin**（Golden-Pigeon/dsh-remote） | 远端会话**镜像成本地原生 Session** + Agent façade + 审批回本地 | SSH + 回环隧道 + 认证 RPC | 远端安装专属 remote-agent；Node 自动下载安装 | 体验最原生（像本机会话）；审批桥；文件树/终端；凭据代理可配；11 个 agent 工具；真机 E2E 记录 | 远端要装专属组件；镜像上限 `mirrorMaxEvents`；默认不给完整远端 GUI（为审批 waterfall 关闭 remote-event carrier）；不支持 Windows 远端/relay | v0.8.19 · 7★ · 2026-11-10 |
| **dsh-zen-remote** | host 把 DSH 变 PWA/网关；client 在另一台 DSH 侧栏**原生使用共享会话** | 配对码 + 网关（Caddy/CF Tunnel/LAN/Tailscale） | 两端都装同版本插件；host 需网关 | 8 台服务器、完整历史/流式/审批同步/终端/文件/Git diff/上传下载；PWA 手机端；安全模型细（私有 IP 墙、会话隔离）；版本容错（DSH 版本可不同） | 非 SSH；需网关与配对；只能看 host 主动共享的会话；两端插件版本必须一致 | v2.4.1 · 28★ · 2026-11-10 |
| **dsh-ssh-desktop**（独立应用） | Windows Electron 外壳：ssh 启动/复用远端 dsh web，端口转发，窗口内显示远端 UI | 系统 ssh（读取 `~/.ssh/config`） | 远端无 DSH 时一键安装 Node/pnpm/DSH/配套插件到 `~/.local/opt`（无需 root） | 多服务器、桌面通知、任务栏角标、睡眠唤醒自动重连、退出策略（保持/停止远端，租约 + 崩溃后约 10 分钟自停）、诊断脱敏、每服务器独立 cookie 分区、VS Code 按钮 | 不是 DSH 插件（独立应用）；Windows 专用；需配套远端插件做通知/租约 | 未上 npm（安装包）· 5★ · 2026-09-30 |
| **dsh-multi-instance**（独立应用） | 多窗格 webview 外壳，按 URL 接入任意 DSH 实例 | 任意 URL（含带 token 的 HTTPS） | 无 | 每窗格独立浏览器 partition（cookie/localStorage 隔离）、自由排布、自动发现本机实例、内置安装 | 每个实例约 241MB 内存；`window.open` 转系统浏览器；仅 Windows；token 存在用户配置里（提醒勿分享）；无 macOS/Linux | v0.0.1 · 2026-10-26 |
| **dsh-sev**（历史） | 侧栏混排 + iframe 远端 GUI | SSH -L | 远端 `dsh web` + systemd | 最早一批类似方案 | 按 DSH 0.1.x 写，0.2.x 上 4 个缺陷导致核心不可用（缺 cookie、RPC 信封过时、`output.render` 契约、inject 不存在的服务） | v0.3.4 · 已过时 |

### 1.1 最接近的项目：`graydovee/dsh-remote-window`（重点）

- 形态：本地 `web` profile 插件 + 浮动 target rail；主区**一个全屏同源 iframe**，显示远端 profile 的官方 DSH UI（sidebar/rightbar/第三方 UI 插件全在）。
- 关键解：**portal 同源字节反代**（剥 client cookie、注入 profile cookie、不转发 Set-Cookie、token 不进 URL）；host key 首次确认并 pin；SSH via ssh2 + `forwardOut`。
- 远端：每 client 一个 `graydovee-remote-window-<clientId>` profile + 离线安装的 server 插件 + 独立 Node/DSH runtime；profile 只绑 127.0.0.1；lease 20s TTL；官方 JSONL flock 单写者。
- 模型：local（默认，反向隧道 + 本机 `ctx.llm` 全量自动代理）或 server；失败 coded 不回退。
- 现状：0.1.0-alpha.6、MIT、npm/GitHub 已占用、0★、未进市场；工程与文档质量高，但真实主机 E2E 仍标注 pending。
- 专项报告：`_design/research/dsh-remote-window-调研.md`。

**邻近产品（形态参照，非 DSH 插件）**

| 产品 | 对我们的意义 |
|---|---|
| VS Code Remote-SSH | 「本地 UI + 远端 Server + SSH」的标准形态；远端装在用户目录、重连、同一 UI、扩展在远端运行 |
| OpenClaw「Chat UI over SSH」 | 长驻 gateway 留在远端，本地通过 SSH 打开它的 Chat UI |
| Hermes Agent 桌面端 | 同样支持 SSH 连远端实例，本地只做呈现 |

---

## 2. 需求清单（从同类项目反推）

> 标记：**采纳** = 进入 `dsh-remote-go` 需求；**参考** = 记录但不进 V1；**不做** = 与薄客户端定位冲突。

| ID | 需求 | 来源项目 | 对 dsh-remote-go 的取舍 |
|---|---|---|---|
| R1 | SSH 主机：自动发现 `~/.ssh/config` 别名；手动填写地址/端口/用户/工作目录；多主机与每主机独立配置 | dsh-remote-tunnel、dsh-ssh-desktop、Golden-Pigeon | **采纳**（自动发现 + 手动表单都进 V1；哈希 known_hosts 条目只统计跳过数，不猜） |
| R2 | 远端就绪探测：keys / Node / dsh / pnpm / systemd / 磁盘 / 模型凭据；缺什么列什么 | dsh-remote-tunnel、dsh-remote-explorer、Golden-Pigeon | **采纳**（向导第 3 步已有，补充「远端桌面功能干扰」检查） |
| R3 | 远端安装/升级：无需 root，装到用户目录；可离线 | dsh-ssh-desktop、dsh-remote-explorer、Golden-Pigeon | **采纳（P1/V1.1）**：V1 只连接已装 DSH；V1.1 支持显式触发安装/升级 |
| R4 | 远端服务托管：systemd user unit 或 nohup；端口分配/注册表；启动/复用/重启；退出策略（保持运行/停止） | dsh-remote-tunnel、dsh-ssh-desktop、Golden-Pigeon | **采纳**（V1 由插件启动并在退出时按设置保留；V1.1 加停止/租约清理） |
| R5 | 隧道韧性：`ssh -L`、看门狗、自动重连、休眠唤醒恢复、收养已有隧道避免重复起 | dsh-remote-gui、dsh-ssh-desktop、dsh-remote-tunnel | **采纳**（补充「收养」与「去重」） |
| R6 | 认证：远端启动 token（每进程随机）→ cookie 兑换；按 host 缓存；401/403 自动刷新重试；可选用户粘贴 token 配对 | dsh-remote-gui、dsh-remote-dsh、dsh-remote-explorer | **采纳**（首选插件自己拉起远端 web 并解析 stdout；兜底用户粘贴地址+token） |
| R7 | 呈现：整页/全局面板；回环地址；空会话也能进入的入口；明确返回/关闭路径；不嵌套本机实例 | dsh-remote-dsh、dsh-remote-gui、dsh-remote-tunnel | **采纳**（全局面板 + 侧栏入口；工具条返回；禁止把本机实例嵌进自己） |
| R8 | 远端会话可见：列表、标题/时间/cwd/运行中/待回答；子代理会话折叠 | dsh-remote-gui、dsh-remote-dsh、Golden-Pigeon | **参考**：我们嵌入远端真实 GUI 后由远端自己显示；只在「最近打开」里做轻量入口 |
| R9 | 通知：任务完成/需要审批时本机通知（桌面通知/角标） | dsh-ssh-desktop、dsh-remote-dsh | **采纳（P1/V1.1）**：优先轮询远端状态；不引入远端专属组件 |
| R10 | 凭据策略：远端自备 key 或本地代理（key 不出机）；日志/诊断脱敏；状态文件 0600 | Golden-Pigeon、dsh-remote-explorer、dsh-ssh-desktop | **采纳**（V1 远端自备；本地代理 V1.2；诊断包脱敏进 V1） |
| R11 | 多用户/共享主机：按远端 OS 账号隔离；共享端口注册表需要 root 一次性配置；同账号共享 session 根 | dsh-remote-tunnel、dsh-remote-explorer、Golden-Pigeon | **参考**（V1 单用户语义；文档写明多用户限制） |
| R12 | 运维诊断：健康检查、日志、导出脱敏诊断、端口/隧道审计 | dsh-remote-tunnel、dsh-ssh-desktop、dsh-remote-gui | **采纳**（诊断抽屉 + 导出脱敏诊断包进 V1） |
| R13 | 多入口/空态可用：侧栏面板（空会话可见）、页脚图标、命令、状态条 | dsh-remote-tunnel、dsh-remote-gui | **采纳**（侧栏入口 V1；页脚/命令面板 V1.1） |
| R14 | 退出/关闭语义：关闭本地窗口不结束远端任务；可选停止远端 | dsh-ssh-desktop、dsh-remote-dsh | **采纳**（V1 明确提示 + 保持运行；停止策略 V1.1） |
| R15 | 版本兼容：DSH 0.2.x 契约探测与降级；插件两端版本一致（如适用） | dsh-zen-remote、dsh-remote-gui | **采纳**（能力探测 + 不支持版本给出明确提示） |

---

## 3. 注意点 / 坑清单（按严重度排序）

| ID | 坑 | 机制与证据 | 预防措施 |
|---|---|---|---|
| P1 | **回环硬规则**：非回环地址嵌不进远端 DSH | 远端 cookie `dsh-auth-<authority哈希>` 是 `HttpOnly; SameSite=Strict`（硬编码）；跨 site iframe 连 `index.html` 都 401。`http://100.x.y.z:3080` 还会因 Host 不在 trustedHosts 返回 403。证据：dsh-remote-dsh `docs/why-loopback.md` 实测 | 只允许 `127.0.0.1:<本地端口>`；地址非回环时当场警告；FRP 必须 stcp/xtcp visitor 或 ssh -L |
| P2 | **iframe cookie 种入/持久化未验证** | `dsh-remote-gui` 的 seedUrl 没走通，后续版本放弃 iframe 改原生面板；**但已有正解**：`dsh-remote-window` 用**同源 portal 反代**（剥 client cookie、注入 profile cookie、不转发 Set-Cookie）彻底绕开跨站限制，代价是约 3–4 倍工作量 | 作为 **V0 闸门**先验证 seedUrl/portal 两条路；若做 iframe 内嵌，需决定是否实现 portal；否则正式降级「在新窗口打开」 |
| P3 | **token 发现方式脆弱** | `dsh-remote-gui` 依赖远端 systemd unit 固定名为 `dsh-web`，用 `journalctl --user -u dsh-web` 抓 token；unit 改名/非 systemd 就失效；token 每进程随机 | 自己拉起远端 `dsh web` 并解析 stdout；兜底用户粘贴 URL+token；缓存 token 设 TTL，401 时强制刷新 |
| P4 | **嵌套实例** | dsh-remote-gui 默认本地模式时把本机 `location.origin` 嵌进 iframe，用户看到「HARNESS / Loading plugins…」套娃，误以为卡死 | 默认目标永远是远端；禁止把本机实例嵌进自己；「本地模式」只列本机会话，不嵌 iframe |
| P5 | **远端桌面功能误开** | DSH 用 `launchedThroughSsh`（env 有 `SSH_CONNECTION`/`SSH_TTY`）判断是否坐在本机；systemd/计划任务启动时该信号缺失 → 目录选择器用原生对话框、Open In 出现、启动自动开浏览器——都发生在远端屏幕上 | 启动远端 web 时带上 SSH 环境（用 ssh 会话启动）或在 systemd 环境显式设置标记；向导里检查 5 组配置并提供提示 |
| P6 | **契约漂移**（DSH 0.2.x 无兼容承诺） | typert RPC `args` 的 key 是**方法形参名**：`session/list` 是 `_request`，其余多为 `request`；用错会 HTTP 200 + `ok=false`（静默失败）。流式方法必须走 WS `/api/remote.mux`，一元 POST 会被拒 | 只依赖少量稳定端点；集中适配层 + 能力探测；成功判定看 `result.ok` 而非 HTTP 状态；需流式时走 WS |
| P7 | **会话噪声** | 真实远端 346 条会话里 317 条是子代理/子任务（dsh-remote-gui 实测）；平铺列表会埋掉主会话 | 我们嵌入远端 GUI 由它自己折叠；若做「最近会话」入口，按 `parentSessionId` / `origin==='subagent'` 折叠 |
| P8 | **归档状态不是权威** | `session/list` 不含 archived 字段，真正归档在流式 workspace 通道；dsh-remote-gui 只能本地 localStorage 记「我归档过」 | 不要在本地伪造归档结果；如需要以远端 `workspace/*` 流为准，或不做归档 |
| P9 | **token 落盘风险** | dsh-multi-instance 明确警告：profile 里可能含用户填过的 token，目录别分享/入库；dsh-remote-gui 把 cookie 放内存、hosts 注册表不含 token | token 默认只在内存；确需持久化时 0600 + 明确提示；诊断包/日志脱敏 |
| P10 | **文档与实现漂移** | dsh-remote-gui README 仍写「面板内嵌远端 GUI（iframe）」，但 HEAD client.js 已改成无 iframe 的原生面板；SPEC 与 client-notes 也有互相矛盾处 | 我们的文档以**代码/实测**为准；功能状态写「已验证/未验证」；发布前跑一遍官方界面验收 |
| P11 | **资源占用** | dsh-multi-instance 实测每实例约 241MB（12 实例 2897MB）；每个远端 dsh web 也是独立进程 | 单主机单服务；不并发多开远端 web；本地只保留轻量 panel |
| P12 | **空会话入口缺失** | dsh-remote-tunnel：命令卡/状态条在空会话不渲染，侧栏面板才是保底入口 | 侧栏入口 + 全局面板必须在任何会话状态可用；不依赖会话内 dock |
| P13 | **多用户/共享主机** | 同远端 OS 账号共享 session 根与端口；共享端口注册表需 root 一次性建组；不同账号才隔离 | V1 明确单用户；文档写清「同账号即共享」；不做共享注册表 |
| P14 | **危险/花钱操作** | 发消息会真实消耗 token；dsh-remote-gui 用两步确认（第一下变「确认发送（会花钱）」），且不用 `window.confirm`（会阻塞自动化） | 我们的入口只做「连接/打开」，花钱操作在远端 GUI 内由它确认；首次进入提示「操作在远端执行」 |
| P15 | **远端是「别人的机器」** | 远端 DSH 拥有该账号权限；approval policy/sandbox 由远端决定；多用户主机上同权限用户可能借用你的凭据隧道配额（explorer 已说明） | 只连可信账号；V1 不支持多用户；安全提示里写清信任边界 |

---

## 4. 对我们设计的直接结论

**保留（设计正确）**

- 薄客户端 + 全局面板 + 嵌入远端真实 GUI：比 dsh-remote-gui 的原生小 UI 省一个数量级；比 dsh-remote-local-plugin 的镜像方案少依赖内部契约。
- 回环 + SSH 隧道 + token/cookie 兑换：与 dsh-remote-dsh 的可行路径一致，已有公开实测依据。
- 远端零专属组件：与 explorer/ssh-desktop 的「远端只装 DSH」一致，减少运维面。

**新增（进 V1 需求）**

- SSH 别名自动发现（`~/.ssh/config` + `known_hosts`，哈希条目跳过）。
- 远端宿主检查里的「桌面功能干扰」项 + 启动方式建议（用 SSH 启动或显式标记，避免远端弹窗）。
- 诊断导出默认脱敏；token 只在内存；主机注册表不含凭据。
- 入口在**空会话**也可用（侧栏入口 + 全局面板）。
- 隧道/主机去重与「收养已有隧道」。

**降级/备选（V0 后定）**

- iframe 内嵌失败 → 「在新窗口打开」成为正式降级模式（而不是隐藏功能）；可选隐藏 iframe 预热。
- 需要公网域名访问时，评估「本地同源反代」方案（dsh-remote-dsh 评估工作量约 3–4 倍，不进 V1）。

**不做**

- 不重写远端会话 UI（dsh-remote-gui 已证明维护成本高）；不做本地审批/文件/终端面板。
- 不在远端装专属 peer 插件（状态点/通知可后续用轮询替代；若确需实时，再评估）。
- 不做 relay/NAT 穿透与多用户共享注册表。

---

## 5. V0 可行性验证清单（在写实现前完成）

| # | 验证 | 通过标准 |
|---|---|---|
| V0-1 | 最小全局面板：注册 `main` slot + `ctx.layout.selectPanel`，放入 iframe 指向本地回环隧道 | 能在主区域整页显示远端 DSH 登录页/界面 |
| V0-2 | cookie 种入：首次用带 token 的 seedUrl 加载 | 无 401，后续不带 token 也能加载 |
| V0-3 | 持久化：刷新页面、关闭重开面板 | 仍能直接进入远端界面 |
| V0-4 | 失败降级：模拟 cookie 失败 | 「在新窗口打开」可用且体验可接受 |
| V0-5 | 断线恢复：断网 30 秒后恢复 | 工具条提示 + 自动重连后界面可用 |

---

## 6. 参考资料

- 本地 clone：`_research/vendor/dsh-remote-gui`（dsh-remote-gui 0.1.3 + HEAD 源码）
- 相似项目 README：`_design/research/incoming/`（8 份）
- dsh-remote-dsh 关键文档：`_design/research/incoming/docs__why-loopback.md`、`docs__remote-host-setup.md`、`docs__implementation.md`、`docs__peer-status-badge.md`
- GitHub：
  - https://github.com/temotee2103/dsh-remote-gui
  - https://github.com/hutao562/dsh-remote-dsh
  - https://github.com/Linjiangxian0203/dsh-remote-tunnel
  - https://github.com/btsd321/dsh-remote-explorer
  - https://github.com/Golden-Pigeon/dsh-remote
  - https://github.com/KyoMio/dsh-zen-remote
  - https://github.com/yybai25/dsh-ssh-desktop
  - https://github.com/BOWLUNA/dsh-multi-instance
