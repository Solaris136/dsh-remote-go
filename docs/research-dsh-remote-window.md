# dsh-remote-window 调研报告（只读，不安装）

> 调研时间：2026-11-10 · 对象：`graydovee/dsh-remote-window@0.1.0-alpha.6` + 服务端仓 `graydovee/dsh-remote-window-server`
> 方法：npm/GitHub 元数据 + 源码 tarball（`_design/research/vendor/dsh-remote-window/`）+ 文档/QA/兼容表通读。**未安装、未连接真实主机、未改任何 profile。**

---

## 0. 结论先行

1. **它基本就是我们的设计，而且走得更远。** 本地 DSH 里一个浮动 target rail + 主区全屏 iframe，iframe 里是远端 profile 的**官方 DSH UI 原件**（含第三方 UI 插件）；远端数据（workspace/session/日志）权威；模型来源可选「本机模型经反向隧道」或「远端自己的模型」。这正是 `dsh-remote-go` 想做的事。
2. **它已经解决了我们最大的 V0 风险**：用 **同源 portal 反向代理**（剥 client cookie、注入 profile cookie、不转发 Set-Cookie、token 不进入 URL）把远端 UI 挂到本地 origin 下，从而绕过 `SameSite=Strict` + authority 绑定的跨站 iframe 问题。这恰是 dsh-remote-dsh 评估「工作量 3–4 倍」而放弃的方案。
3. **代价是远端更重**：每个 client 在服务器上有一个专用 DSH profile + 专属 server 插件 + 独立 Node/DSH runtime（`~/.dsh/remote-window/<clientId>/runtime`），不是「零远端组件」。
4. **成熟度：工程质量高，但真实环境验证不足。** alpha.6（2026-11-09），client 626 tests / server 69 tests 声称通过，兼容表有生成门禁，文档/QA 很完整；但 server README 明说 alpha.6「real-host run pending」，v2 QA 报告状态是 NOT RUN，v3 的浏览器 E2E 用 fake sshd + fake LLM + headless Chrome 完成，**真实服务器 + 真实模型 + 真实网络仍待验证**。
5. **名字已被占用且就是同类项目**：npm `dsh-remote-window`（alpha.6）、GitHub 同名仓库都在；它不在当前 DSH 市场缓存/本机市场快照里（所以你市场里没看到），但 npm/GitHub 是公开的。**不建议我们再用这个名字。**

---

## 1. 基本信息

| 项 | 值 |
|---|---|
| 插件包 | `dsh-remote-window` |
| 最新版本 | `0.1.0-alpha.6`（npm `latest` 是 alpha.3，`alpha` tag 是 alpha.6） |
| 发布时间 | 2026-10-20 首个 alpha；alpha.6 约 2026-11-09 |
| 仓库 | https://github.com/graydovee/dsh-remote-window（MIT，0★，2026-11-09 推送） |
| 服务端仓 | https://github.com/graydovee/dsh-remote-window-server |
| DSH 兼容 | `>=0.2.1-rc.2 <=0.2.2-rc.1`（闭区间）；runtime 覆盖 0.2.2-rc.1 / 0.2.1-rc.5 / 0.2.1-rc.3 |
| Node | `^22.19.0 || >=24.0.0` |
| 安装 | `dsh plugin --profile web add dsh-remote-window@0.1.0-alpha.6`，或 GitHub Release tarball |
| 市场收录 | 未进入本机 `~/.dsh/dsh-market` 缓存与 `_research/registry.json` 快照（手动搜索不到，不代表不存在） |

---

## 2. 用户看到的产品形态

- **client 只装一个插件到 `web` profile**；UI 只有两件东西：
  1. **浮动 target rail**（默认收起，hover 或 `Alt+R` 展开；可拖到屏幕四边吸附，记住位置；连接数 >1 时可折叠成 `+N`）；列出已保存连接、实时阶段、连接/切换/忘记。
  2. **主区一个全屏 iframe**，显示 server profile 的官方 DSH UI——sidebar、header、对话、右侧栏、第三方 UI 插件全部是 server 上那一份。iframe 挂载期间 client shell 自己的 sidebar 隐藏。
- **连接对话框**：选 SSH（或 Windows 上的 WSL 目标）→ 填目标 → 首次确认 host key SHA-256 → 探测 server 的 Node/DSH runtime 与 server 插件 → 部署/更新/复用 → 启动 profile server → 选模型来源（local 默认 / server）→ 完成后自动打开 iframe。
- 截图（仓库自带）：server 官方 UI 完整显示，composer 上有 `Remote: dev-machine` 标记，模型 `DeepSeek-V4.1-Flash`。
- **不做的事**：不自绘对话/会话树（v3 已删除 v2 的 native 主区）；不复制 workspace/session 树到 client；一个 client 只挂一个 iframe（切换 target 会重载，不分屏）。

---

## 3. 架构

```text
client（你的电脑）
├─ DSH host 插件：SSH（ssh2）、host key pin、provision、portal、P1 客户端、本机模型 bridge
├─ 浮动 target rail + 连接对话框（唯一 client chrome）
└─ main slot：<iframe src="/dsh-remote-window/portal/<targetId>/?dshRwFull=1">
       └─ portal（同源字节反向代理）──SSH forwardOut──▶ server profile 的官方 dsh web

server（SSH 目标机）
├─ per-client profile：graydovee-remote-window-<clientId>（普通 dsh web，绑 127.0.0.1:0）
├─ server 插件：P1 RPC/SSE、embed bootstrap、lease、registry 写守卫、官方 workspace/session API
├─ 独立 runtime：~/.dsh/remote-window/<clientId>/runtime/{node,dsh}（或只读复用全局 dsh）
└─ 官方数据：~/.dsh/sessions/**（JSONL 权威）、~/.dsh/storages/workspace.json（registry 权威）

模型路径（local 来源）：server profile agent → 反向 SSH 隧道（forwardIn）→ client loopback bridge → 本机 DSH ctx.llm.stream()
```

**四条不变量（README 原文）**：

1. **凭据不过线**：server 模型用 server 自己的凭据；local 模型的 key 只在 client 凭据库，由 bridge 注入。SSH 密钥只在 client。
2. **目标机不监听公网**：profile server 只绑 `127.0.0.1`，client 经 SSH 隧道访问。
3. **每 client 一个 profile、每会话一个写者**：server 插件持 client lease（20s TTL）；官方 JSONL flock 裁决写者，第二个写者得到 `session/writer-held`。
4. **server 是权威**：workspace 清单/标题/顺序/pin/archive 来自官方 `workspaceRegistry`；会话清单/标题/运行态/rename/fork/cancel 来自官方 `sessionController`；client 只做内存搜索过滤。

---

## 4. 关键机制（最值得学习/警惕的部分）

### 4.1 同源 portal：解决 iframe cookie 的正解

- iframe 的 src 是 **client 自己的 origin**（`/dsh-remote-window/portal/<targetId>/?dshRwFull=1`），portal 是纯字节反向代理：
  - 剥掉 client GUI 的 cookie，注入 profile server 的 cookie；
  - **不转发 `Set-Cookie`**；profile 的 launch token 只存在 client host 内存，**不出现在 iframe URL**；
  - HTTP prefix + WebSocket exact 两条路径；每个路由过 `trustedRequest`，body ≤ 1 MiB；
  - iframe sandbox 固定 `allow-scripts allow-same-origin allow-forms allow-popups allow-downloads`，不给 top-navigation；
  - 20s 内未收到 `dsh-rw/ready` 显示可重试错误；iframe key 含 `targetId:revision:reloadCount`，切换/重连必重挂载；
  - 深链 `dshRwSession=<sessionId>`，否则 iframe 会落在官方「选择工作区」首启页且无法恢复。
- **这正是我们设计里 V0 要验证的东西**：他们不是靠「跨域 iframe + SameSite 放宽」，而是靠「本地同源代理」。我们如果自研，必须决定：做 portal（工作量大但体验对）还是接受「外部窗口打开」降级。

### 4.2 runtime / profile 生命周期

- 版本契约单一来源 `compat/runtimes.json`（schema 2：plugin 版本 + dsh 闭区间 + 每平台可用 runtime），`scripts/sync-compat.mjs` 生成 `engines.dsh`、全部 peer、两份 README 表格；`--check` 是发布门禁。
- runtime 选择优先级：`DSH_RW_RUNTIME_ARTIFACT` → 区间内且健康的全局 DSH → 本地缓存 → 已发布 release 产物 → POSIX 宿主本机构建 → 拒绝。区间内无产物报 `no-artifact`。
- 启动命令固定：`DSH_HOME=... exec <dsh> --profile <p> --host 127.0.0.1 --port 0 --no-open`；从 stdout 单行正则解析 `dsh web: http://127.0.0.1:<port>/?token=<token>`，token 只进 0600 日志与 host 内存。
- server 插件**离线安装**：client 包内置精确同版本 tarball（`assets/server-plugin/*.tgz` + checksums），不依赖目标机网络/pnpm；profile 只在 marker 不匹配时重装。
- 断开连接：cancel/flush → 停 profile server → 关隧道；重连复用上次解析出的绝对 `remote.dshHome`（否则 patch/隧道会写到错误 home，这是他们踩过的 bug）。
- Windows 远端：PowerShell `-EncodedCommand`、`Win32_Process.Create` 启动（`Start-Process` 会随 SSH 通道被杀）、`taskkill /T /F`、90s 启动预算、win32 runtime 产物不用符号链接。

### 4.3 双模型来源

- **local（默认）**：agent/工具/日志仍在 server，模型请求经反向隧道回 client；自动用本机 `ctx.llm.listProviders()/listModels()` 枚举**全部** provider/model，每个 provider 生成一条 `remote-<slug>` route；本机暂时没有模型也能连接（不启动 bridge，profile 用 server 自己的模型）。
- **server（可选）**：profile 用 server 自己配置的模型；切换来源要重连（D20：先 cancel、whenIdle/flush、再重启 profile，绝不静默打断）。
- 失败一律 coded error，**不静默回退**（`local-llm-*`、`local-llm-forwarding-unavailable` 等）。

### 4.4 安全与数据权威

- host key 首次展示 SHA-256 并显式确认；已 pin 的 key 变化立即中止；WSL 目标没有 host key 环节。
- 凭据/模型 key/SSH 密钥只在需要的一端；错误、日志、SSE detail 一律 scrub。
- server 插件对官方 `workspaceRegistry` 的写守卫是唯一受控例外（带版本守卫、幂等标记、失败降级）。
- 每 client 一个 profile lease（20s TTL），第二实例 `profile-in-use`，异 client `profile-foreign-client`；官方 JSONL flock 让第二个写者得到 `session/writer-held`。

---

## 5. 功能清单（按 README/源码核对）

| 能力 | 状态 |
|---|---|
| 全屏官方 DSH UI（同源 iframe，含 sidebar/rightbar/第三方 UI 插件） | 已实现（v3 主路径） |
| 浮动 target rail、连接/切换/忘记、拖拽吸附、折叠 | 已实现 |
| SSH / Windows WSL 两种连接方式 | 已实现（Docker 已退役） |
| host key pin、首次确认、变化中止 | 已实现 |
| runtime 复用/部署、server 插件离线安装、per-client profile | 已实现 |
| 本机模型自动代理（反向隧道 + 原生 ctx.llm.stream） | 已实现 |
| server 模型来源 | 已实现 |
| workspace/session 官方语义（rename/fork/pin/archive/order） | 已实现 |
| 连接对话框、deployment 探测、错误码/排障表 | 已实现 |
| 断线重连（SSH 5 次指数退避）、D20 cancel 保护 | 已实现 |
| Windows server 目标 | 支持，但需预置 runtime artifact 或复用全局 dsh |
| 会话删除 | **不做**（官方 DSH 无此能力） |
| 两个 server 分屏 | **不做**（一个 client 只挂一个 iframe，切换重载） |
| 多 client 实时同步 | **不做**（D19：刷新/重连后一致，不是实时推送） |
| 全局 runtime 安装/升级 | **拒绝**（只读复用；专用 profile 的 runtime 才自动管理） |
| 升级共享全局 DSH/其它 profile 插件 | 拒绝并给可操作错误 |

---

## 6. 成熟度与质量信号

**强信号**

- 两个仓库（client + server），逐字节共享 `protocol.ts` / `frame/codec.ts` / `frame/mux.ts` 三个文件；CI 会 `cmp`。
- `tsdown` 构建、`tsc --noEmit`、vitest；文档称 client 626 passed / server 69 passed；本轮 v3 分支记录 client 626 tests。
- 兼容表由脚本生成，`sync-compat --check` 作为发布门禁；release workflow 带 npm provenance。
- 文档极完整：`AGENTS.md`（开发契约）、`doc/architecture.md`（72KB）、`doc/api-contract.md`（80KB）、`doc/refactor-v1-*`、`doc/refactor-v3-full-ui.md`、`doc/qa-*`、`doc/acceptance-gap.md`、`doc/windows-server-support.md`。
- 有 fake sshd / fake LLM / headless Chrome CDP 的 v3 E2E 记录与截图。

**风险信号**

- **真实主机端到端未完成**：server README 对 alpha.6 写「verified automatically on 0.2.2-rc.1; **real-host run pending**」；v2 QA 报告状态 `PREPARED / NOT RUN`；v3 E2E 是 fake sshd + fake LLM + headless，不是真服务器。
- **文档漂移**：server README 还写「client renders server conversation natively in v2；legacy embed/portal 只作 v1 fallback」，但 client v3 已把 portal/iframe 作为主路径——两仓文档不同步。
- 0 star / 0 fork、alpha 阶段、单人维护感强；API/协议仍在快速演进（v1→v2→v3，v2 主区已被删除）。
- 远端较重：每个 client 一个 profile + server 插件 + 独立 runtime；对「只想用一下」的用户成本高。

---

## 7. 与我们的设计对比

| 维度 | dsh-remote-window | 我们（dsh-remote-go 设计） |
|---|---|---|
| 远端依赖 | 专用 profile + server 插件 + 独立 runtime（重） | 原设计：零远端专属组件（轻） |
| 客户端工作量 | 很大：SSH/provision/portal/P1/model bridge（host 378KB + client 145KB 的构建产物） | 小：SSH + 全局面板 + 状态 |
| iframe/cookie | **已解决**（同源 portal） | 未解决（V0 风险，可能降级外部窗口） |
| 模型来源 | local 自动代理（默认）+ server 可选 | 远端自备（V1），本地代理 V1.2 |
| 数据权威 | server 官方服务（workspace/session/日志） | server（同） |
| 多主机 | 多 target，但单 iframe、切换重载 | 多主机窗口/切换 |
| 维护成本 | 高（两仓 + 协议 + runtime 矩阵 + Windows 方言） | 低（只依赖远端已有 dsh web） |
| 名字 | 已被占用 | 需换名 |

**结论**：它几乎是我们的「完整版」，但把复杂度放在了 client 与 server 两端；我们的差异化只能是：**零远端组件、部署更轻、多机体验更好、或更简单的维护半径**——如果这些差异不是用户真实需求，自研就是重复造轮子。

---

## 8. 建议

1. **不要再用 `dsh-remote-window` 作为我们项目的名字**（npm/GitHub 均占用，且就是同一件事）。
2. **优先级排序**：
   - **路线 A（最省力）**：直接试用/采用它；或 fork 两仓做定制（它已解决 portal、lease、模型桥、runtime 矩阵）。风险：alpha、实机验证不足、远端重。
   - **路线 B（差异化）**：坚持「零远端组件 + 轻量」：不装 server 插件、不建 per-client profile，只用远端现有 `dsh web` + SSH 隧道；但要自己解决同源 portal（或接受「外部窗口打开」降级）。
   - **路线 C（换形态）**：做多机分屏/团队共享/移动端等它明确不做的方向。
3. **本轮只做了只读调研，未安装**（按你的要求）。如果之后允许，建议用隔离 `DSH_HOME` + 现有服务器做真机验证，重点看：真实 SSH/网络、真实模型、审批、断线重连、Alpha 的 profile 残留。
4. **命名**：如果继续自研且想保留「窗口」意象，可考虑 `dsh-remote-viewfinder`、`dsh-remote-windowpane` 等（npm/GitHub 未占用）；否则保留现有的 `dsh-remote-go`。

---

## 9. 证据索引（本地）

- 源码：`_design/research/vendor/dsh-remote-window/`（README-zh、package.json、AGENTS.md、src/、doc/、compat/、assets/）
- 关键文件：`README-zh.md`、`package.json`、`AGENTS.md`、`doc/refactor-v3-full-ui.md`、`doc/milestone.md`、`doc/qa-v2-report.md`、`doc/acceptance-gap.md`、`compat/runtimes.json`、`assets/server-plugin/`
- 服务端 README：`_design/research/incoming/graydovee__dsh-remote-window-server.md`
- npm：https://www.npmjs.com/package/dsh-remote-window · https://www.npmjs.com/package/dsh-remote-window-server
- GitHub：https://github.com/graydovee/dsh-remote-window · https://github.com/graydovee/dsh-remote-window-server
