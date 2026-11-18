# 不变量登记（审计编号 → 测试 → 代码）

> 本文件是 `.agents/refactor` 审计标记（review 第 8 条）的唯一登记处：**12 条不变量正文 + 44 行出现点映射表**。
> 编号来源是各模块注释里的 `(B1)` / `(H4)` / `(M3)` 之类标记；标记只说明"这一行在守哪条不变量"，
> 解释、保护测试与当前位置一律以本文件为准。
>
> **维护约定（每次改代码/测试/文档都要遵守）**
>
> 1. **新增审计编号必须同时登记。** 代码里第一次出现 `(X7)` 时，本文件必须同时新增 `### X7 — …` 正文
>    与对应映射行；编号**只增不改、永不复用**（删掉的编号也不回收）。
> 2. **44 行是 review 的审计基线，行数固定。** 每行对应 `b52b02f`（review 基线）里的一个标记出现点；
>    代码搬动/拆分只改"今天的位置"列，不删行、不合并行。
> 3. **同一编号可能有多处标记。** P2/P5 的模块拆分把部分注释复制到了新文件头（当前 `src/**/*.ts` 共
>    55 处标记 / 54 行去重），它们都归入该编号已有的行（"今天的位置"可含多个 `file:line`），不新增行。
> 4. **"由谁保护"必须是现存的 `test('…')` 名字**（见 `test/unit/*.test.ts`）；测试改名或搬家时同步本文，
>    否则这条不变量等于没有证据。
> 5. **状态只有三种**：`COVERED` / `PARTIAL` / `UNCOVERED`。`PARTIAL`、`UNCOVERED` 必须在 §3 列出，
>    并给出补测编号（T-a…）；补测落地后立刻改回 `COVERED`。
>
> 复核方式（只读）：
> `grep -rnE '\((B|H|M)[0-9]+\)' src --include=*.ts` 应得到 **55 处标记 / 54 行去重**（`src/connect/guards.ts:3`
> 一行同时带 `(H4)` 与 `(H3)`）；与本文件 §2 的"今天的位置"逐条对照。

## 0. 编号族与总表

| 族 | 含义 | 编号 |
|---|---|---|
| **B** | 边界归属：两个安全/信任上下文（跳板机与目标机、远端与本地、准入与放行）不得互用 | B1、B4、B8 |
| **H** | Harness 生命周期：连接/重试/断开/共享状态在多次 await 与用户操作之间必须保持一致 | H1、H2、H3、H4 |
| **M** | 远端机制：远端进程、文件、凭据与注册表的身份与所有权 | M1、M2、M3、M4、M6 |
| ~~L~~ | **不存在 L 族**：规划里的"L 系列"已并入 H（传输/断链类）；全仓库无 `(L\d+)` | — |

| 编号 | 一句话不变量 | 审计出现点（基线） | 状态 |
|---|---|---:|---|
| B1 | 跳板机与目标机的指纹/策略/prompt 上下文永不互用；重挂得到的 pid 只有展示权、无 kill 权 | 6 | COVERED |
| B4 | 接管必须以非空 launch token 为前提，空 token 永不算成功 | 1 | COVERED |
| B8 | 远端还活着但代理请求失败时，只重建本地 listener，绝不重启远端进程 | 1 | COVERED |
| H1 | 远端家目录只能来自探测结果或本次连接记住的值，任何时刻不得构造带字面 `~` 的远端路径 | 4 | COVERED |
| H2 | 自动重试预算只有一处决定；用户主动 connect 重置、失败消耗、用户的"否"是终局 | 5 | COVERED |
| H3 | 传输关闭导致的失败一律归类为可重试的断链，绝不归类为用户的主机指纹/认证决定 | 7 | COVERED |
| H4 | 每个 await 之后、发布状态之前都要确认"这次连接仍被需要"；过期写入不得复活连接或泄露 listener | 6 | COVERED |
| M1 | 挂起的主机指纹/冲突提问必须能被 teardown 结算；已结算的提问不接受迟到的回答 | 3 | COVERED |
| M2 | 启动失败必须停掉它已经启动的远端进程；即使就绪行解析失败也要保留已拿到的 pid | 2 | COVERED |
| M3 | 远端 dump/log 只在 0600 下创建，且成功与失败两条路径都删除 | 2 | COVERED |
| M4 | 远端进程以 run registry 为准：原子写入、只在确认停止后按 pid 删除、残缺记录仍能解析出 pid | 6 | COVERED |
| M6 | Windows 元数据与 shell 快捷方式永不写入下载结果，被跳过时必须在结果里报告 | 1 | COVERED |

**覆盖统计（P6a 收口后）**：12 条正文 · 44 行出现点 · **44 COVERED / 0 PARTIAL / 0 UNCOVERED**；
12 条不变量 **12 COVERED / 0 PARTIAL / 0 UNCOVERED**。
对照 review 基线（`b52b02f`）的 39/4/1：4 个 PARTIAL（#14、#25、#27、#28）与 1 个 UNCOVERED（#32）
由 §3 的 T-a…T-e 五个真实单测补齐，逐行证据见 §2。

## 1. 12 条不变量正文

### B1 — 跳板机与目标机的主机指纹上下文永不互用

- **不变量**：一次连接里，跳板机与目标机各自持有自己的 policy / pin / prompt role；一个确认过的 key
  永远不能被当作另一台机器的 key 校验或写回；重挂（re-attach）得到的 pid 只有展示权，没有 kill 权。
- **为什么**：两个不同机器的 key 一旦共用 pin，等于用 A 机的信任去放行 B 机（中间人可复现）；重挂 pid
  来自远端文件系统记录，不是本连接启动的，给它 kill 权等于允许停掉别的实例（甚至别的用户的进程）。
- **由谁保护**：`a jump host and the target keep separate host-key contexts`；
  `the target host-key policy does not apply to the jump host`；
  `an existing target pin never reaches the jump host connection`；
  `editing the jump host re-asks for its key instead of reporting host-key-changed`；
  `a re-attach to a pid this connection did not launch grants no kill rights`；
  `stop never signals a pid this connection did not launch or take over`。
- **代码位置**：`src/connect/pipeline.ts:155`、`:355`、`src/host-runtime.ts:243`、`src/prompts.ts:126`、`:196`、
  `:224`、`src/runtime/fsm.ts:347`
- **状态**：COVERED

### B4 — 接管必须以非空 launch token 为前提

- **不变量**：re-attach 只有在拿到**非空** launch token 时才算成功；空 token 一律显式失败，绝不把
  一个没有新启动行的实例当作可接管。
- **为什么**：token 是"这个远端 web 是本次启动的"唯一凭证。空 token 说明没有新的启动行，接管会把
  恰好占着同一端口的进程认成自己的实例——既无法验证身份，也证明不了 kill 权。
- **由谁保护**：`a re-attach that returns an empty token is an explicit failure`；
  `resolveRemoteWeb reports no-token instead of accepting an empty token`；
  `resolveRemoteWeb never takes over without a launch token (process-scan fallback degrades)`。
- **代码位置**：`src/connect/reattach.ts:128`
- **状态**：COVERED

### B8 — 远端活着但代理请求失败时，只重建本地 listener

- **不变量**：远端 UI 本身可服务（SSH 探活通过）而仅代理转发失败时，只重建本地隧道，绝不重启远端进程。
- **为什么**：把代理故障当成连接故障会重启远端，丢掉远端正在跑的任务；真正的故障域只是本地 listener，
  重启远端是代价最大且不可逆的"修复"。
- **由谁保护**：`a broken tunnel under a healthy remote is rebuilt once instead of flapping`；
  `a healthy local listener is not rebuilt for one failed request`。
- **代码位置**：`src/connect/repair.ts:3`、`src/connect/watchdog.ts:21`、`src/runtime/fsm.ts:549`
- **状态**：COVERED

### H1 — 远端家目录只能来自探测结果或本次连接记住的值

- **不变量**：远端路径永不构造带字面 `~` 的形式；home 只能来自 probe facts，或本次连接在 teardown 前
  记下的 `remoteHome`。
- **为什么**：`~` 在非登录 shell、引号语境或 `kill -0` 里不会按预期展开（`kill -0 ~/x` 甚至返回成功），
  错误 home 会把日志、registry、Node 安装写到错误位置，或让停止信号落到错误的目标。
- **由谁保护**：`a remote layout refuses an unknown home instead of building a literal-tilde path`；
  `the idle policy remembers the real remote home and pid across the teardown`。
- **代码位置**：`src/connect/pipeline.ts:313`、`src/host-lifecycle.ts:198`、`:381`、`src/host-runtime.ts:259`、
  `src/runtime/fsm.ts:515`
- **状态**：COVERED

### H2 — 自动重试预算只有一处决定

- **不变量**：重试预算只由 `scheduleReconnect` 决定；用户主动 connect 重置、失败消耗、用户的"否"是终局；
  定时重试不重置预算，只有成功 attach 才把预算清零。
- **为什么**：预算若散落在多个模块，就会出现两条重试循环（或永远不重试）；用户的"否"若再问一次，
  既是骚扰，也可能被误当成接受，而首次手动连接失败就无限重试会把错误变成不可见的后台循环。
- **由谁保护**：`autoReconnect.maxAttempts is the real retry budget, not one attempt`；
  `a first connect that fails with error+close synchronously is not retried`；
  `a transport that closes while a host-key prompt is open is a dropped link and is retried`；
  `connect.failed only arms a retry while the user still wants the link (H2)`；
  `a successful attach resets the retry budget exactly once`（T-d）。
- **代码位置**：`src/host-runtime.ts:193`、`src/connect/pipeline.ts:516`、`src/runtime/fsm.ts:61`、`:65`
  （两处重置点：`src/runtime/fsm.ts:280` 用户 connect 重置、`:427` 成功 attach 清零）
- **状态**：COVERED（原 PARTIAL：#14 由 T-d 补齐）

### H3 — 传输关闭导致的失败一律归类为可重试的断链

- **不变量**：传输关闭导致的失败是可重试的网络断链，绝不归类为用户的主机指纹/认证决定。
- **为什么**：误归类为 `host-key-unknown` / `auth` 会让 UI 弹指纹确认或要求重输凭据，而真实原因只是
  链路抖动；它同时会阻断重试、把可恢复故障变成用户眼里的"配置错了"。
- **由谁保护**：`a transport dropped during bootstrap is a network failure and is retried`；
  `a transport that closes while a host-key prompt is open is a dropped link and is retried`。
- **代码位置**：`src/connect/failures.ts:4`、`:25`、`src/connect/guards.ts:3`、`:45`、`src/connect/pipeline.ts:253`、
  `:280`、`:489`、`src/host-runtime.ts:199`、`src/runtime/fsm.ts:63`
- **状态**：COVERED

### H4 — 每个 await 之后、发布状态之前都要确认"这次连接仍被需要"

- **不变量**：每个 await 之后、任何状态发布之前都确认连接仍被需要（未 dispose、未 closing、
  `desired === 'connected'`、仍在 registry）；过期写入不得复活连接，也不得泄露 listener/tunnel。
- **为什么**：用户在任意 await 窗口都能断开、删除主机或退出进程；迟到的写入会把已关闭的连接重新发布成
  `connected`（客户端随即打开一个死链），或留下无人引用的 listener/tunnel 泄漏资源。
- **由谁保护**：`assertStillWanted rejects every taken link and accepts a live one`（T-e）；
  `a token exchange that lands after a user cancel never touches the closed tunnel`（T-c）；
  `a disconnect after the store write but before markConnected publishes nothing`（T-b）；
  `a disconnect while the new listener is being created closes that listener`；
  `removing the host while the new listener is being created cannot leak it`；
  `shutting down during a tunnel rebuild closes the new listener`；
  `a disconnect during an unconfirmed stop never resurrects the connection`；
  `removing a host during an unconfirmed stop cannot resurrect it`。
- **代码位置**：`src/connect/guards.ts:3`、`:40`、`src/connect/transport.ts:109`、`src/connect/verify.ts:28`、
  `src/connect/pipeline.ts:469`、`:478`、`src/host-registry.ts:180`
- **状态**：COVERED（原 PARTIAL：#25/#27/#28 由 T-e/T-c/T-b 补齐）

### M1 — 挂起的提问必须能被 teardown 结算；已结算的提问不接受迟到的回答

- **不变量**：teardown / 断开必须把挂起的主机指纹与冲突提问结算掉；已结算（回答、超时、teardown）的
  提问必须拒绝迟到的回答，迟到回答不得复活尝试、不得写 pin。
- **为什么**：不结算会让 connect promise 一直挂到 120s 超时（用户已经放弃了）；而接受迟到回答会把已经
  结束的尝试重新推进，甚至把一份过期的"记住指纹"写进 store。
- **由谁保护**：`a disconnect during a host-key prompt settles the connect immediately`；
  `a host-key prompt that times out clears its pending state`；
  `answering a host-key prompt twice is refused: a late answer cannot revive a settled attempt`（T-a）。
- **代码位置**：`src/host-lifecycle.ts:371`、`src/prompts.ts:240`、`:297`、`:397`、`src/runtime/effects.ts:64`
- **状态**：COVERED（原 UNCOVERED：#32 由 T-a 补齐）

### M2 — 启动失败必须停掉它已经启动的远端进程

- **不变量**：远端 web 启动失败（含就绪行解析失败、等待超时）必须停掉本次已启动的 pid；即使就绪行没
  解析出来，也要保留 `PID:` 行已给出的 pid 用于停止。
- **为什么**：否则每次失败都在远端留下一个孤儿 `dsh web`，占着同一个 `~/.dsh` profile；下一次连接会
  遇上冲突提示或两个实例共享会话文件，失败会累积成远端环境损坏。
- **由谁保护**：`startRemoteWeb stops the process it already launched when the start fails`
  （同一用例覆盖"就绪行不可用"与"等待超时"两条路径）。
- **代码位置**：`src/remote-web/start.ts:4`、`:196`、`:262`
- **状态**：COVERED

### M3 — 远端 dump/log 只在 0600 下创建，且成功与失败两条路径都删除

- **不变量**：浏览器半端的 profile dump 与启动日志只在私有权限（`umask 077` / `0600`）下创建；dump 在
  成功与失败两条路径都被删除。
- **为什么**：dump 与日志含会话 material 和 launch URL（带 token）；可读的临时文件等于把凭据泄露给同机
  其它用户，而"成功才删"会恰好把最长命的失败现场留在盘上。
- **由谁保护**：`buildBrowserCarrierProbe dumps the profile and only then writes the overlay`；
  `the launch script keeps its private files private and writes the registry atomically`。
- **代码位置**：`src/remote-web/start.ts:78`、`:141`
- **状态**：COVERED

### M4 — 远端进程以 run registry 为准

- **不变量**：远端进程身份以 run registry 为准：原子写入（temp + rename）、只在确认停止后按 pid 删除、
  残缺/旧格式记录仍能解析出 pid；pid 未知时才用就绪行 + `/proc` 反查作为最后手段。
- **为什么**：registry 是唯一能证明"这个 pid 是本插件启动的"的持久证据。非原子写会留下半行，让 adopt
  误读 pid；删早了会失去唯一的 pid；只信内存则本地进程重启后就再也找不到那个远端实例。
- **由谁保护**：`the run registry is written through a temp file and renamed`；
  `the launch script keeps its private files private and writes the registry atomically`；
  `resolveRemoteWeb recovers a new pid from a fresh readiness line`；
  `stopRemoteWeb reports no-target when neither a pid nor a registry names the process`；
  `stopRemoteWeb keeps the run registry when the process does not confirm its stop`；
  `stop from remote-unreachable clears the stale registry and releases the link`；
  `a truncated registry that names no complete pid yields no record`；
  `a run registry that does not parse still yields the pid it names`。
- **代码位置**：`src/remote-web/registry.ts:5`、`:64`、`:174`、`src/remote-web/start.ts:143`、
  `src/remote-web/stop.ts:5`、`:23`、`:40`、`:47`
- **状态**：COVERED

### M6 — Windows 元数据与 shell 快捷方式永不写入下载结果

- **不变量**：下载远端文件/目录时，Windows 元数据（`desktop.ini`、`Thumbs.db` 等）与 shell 快捷方式
  （`*.lnk`、`*.url` 等）永不落盘；被跳过时必须在结果里报告被跳过的名字。
- **为什么**：远端内容可能是攻击者可控的，把这些文件写进本地下载目录可能变成劫持/自启动入口；静默跳过
  又会让用户以为下载是完整的。
- **由谁保护**：`Windows metadata and shell shortcut names are never written into a download`；
  `saveRemoteTree leaves Windows metadata and shell shortcut files out`。
- **代码位置**：`src/ssh-sftp.ts:167`
- **状态**：COVERED

## 2. 44 行出现点映射表

> 列说明：**审计出现点**是 review 基线 `b52b02f` 的 `文件:行`（44 行的来源，永不改动）；
> **今天的位置**是同一保证在当前 `src/**/*.ts` 的落点（模块拆分后可能一行对多处，见 §0 约定 3）。

| # | 编号 | 审计出现点（b52b02f） | 今天的位置 | 这一行在保证什么 | 保护测试 | 状态 |
|---:|---|---|---|---|---|---|
| 1 | B1 | `src/connect-pipeline.js:314` | `src/connect/pipeline.ts:155` | `openTransport` 为 jump/target 各发一套 options（policy、pin、`onHostKey` role） | `a jump host and the target keep separate host-key contexts`；`the target host-key policy does not apply to the jump host` | COVERED |
| 2 | B1 | `src/connect-pipeline.js:952` | `src/connect/pipeline.ts:355` | 重挂记录是"托管"不是"拥有"，只有 launch 脚本写的记录才证明可停 | `a re-attach to a pid this connection did not launch grants no kill rights`；`stop never signals a pid this connection did not launch or take over` | COVERED |
| 3 | B1 | `src/host-runtime.js:42` | `src/host-runtime.ts:243` | `jumpFingerprint` 与目标 `fingerprint` 是两个字段 | `a jump host and the target keep separate host-key contexts`；`editing the jump host re-asks for its key instead of reporting host-key-changed` | COVERED |
| 4 | B1 | `src/prompts.js:12` | `src/prompts.ts:126` | `requestHostKey` 用 `role` 决定回答归属 | `a jump host and the target keep separate host-key contexts` | COVERED |
| 5 | B1 | `src/prompts.js:73` | `src/prompts.ts:196` | 当前被确认的 key 必须就是 `HostView.fingerprint` 显示的那个 | `a jump host and the target keep separate host-key contexts`（`:72` 断言 jump key，`:95` 断言目标 key）；`connect pauses on the first host key and resumes after confirmation` | COVERED |
| 6 | B1 | `src/prompts.js:97` | `src/prompts.ts:224`、`src/runtime/fsm.ts:347` | jump key 只记内存，绝不写 `store.pinnedFingerprint` | `a jump host and the target keep separate host-key contexts`（`:79` 断言 store 未被改写）；`an existing target pin never reaches the jump host connection` | COVERED |
| 7 | B4 | `src/connect-pipeline.js:1782` | `src/connect/reattach.ts:128` | 空 token 直接判失败 | `a re-attach that returns an empty token is an explicit failure`；`resolveRemoteWeb reports no-token instead of accepting an empty token` | COVERED |
| 8 | B8 | `src/service.js:173` | `src/connect/repair.ts:3`、`src/connect/watchdog.ts:21`、`src/runtime/fsm.ts:549` | `repairTunnel` 只重建 listener | `a broken tunnel under a healthy remote is rebuilt once instead of flapping`；`a healthy local listener is not rebuilt for one failed request` | COVERED |
| 9 | H1 | `src/connect-pipeline.js:912` | `src/connect/pipeline.ts:313` | 探测没给 `$HOME` 时 `layoutForRuntime` 抛错，而不是造出 `~/.dsh` | `a remote layout refuses an unknown home instead of building a literal-tilde path` | COVERED |
| 10 | H1 | `src/host-lifecycle.js:320` | `src/host-lifecycle.ts:198` | 空闲停止用"记住的 home/pid"，不用被清空后的 `facts` | `the idle policy remembers the real remote home and pid across the teardown` | COVERED |
| 11 | H1 | `src/host-lifecycle.js:509` | `src/host-lifecycle.ts:381` | teardown 前把 `remoteHome` 存下来 | `the idle policy remembers the real remote home and pid across the teardown` | COVERED |
| 12 | H1 | `src/host-runtime.js:63` | `src/host-runtime.ts:259`、`src/runtime/fsm.ts:515` | `remoteHome`/`remotePid`/`remoteProfile` 三字段存在 | `the idle policy remembers the real remote home and pid across the teardown` | COVERED |
| 13 | H2 | `src/connect-pipeline.js:157` | `src/runtime/fsm.ts:65`、`:280` | 用户主动 connect 重置预算，定时重试保留已花掉的预算 | `autoReconnect.maxAttempts is the real retry budget, not one attempt` | COVERED |
| 14 | H2 | `src/connect-pipeline.js:776` | `src/runtime/fsm.ts:427` | 只有成功 attach 才重置预算，失败一律消耗 | `a successful attach resets the retry budget exactly once`（T-d）；`autoReconnect.maxAttempts is the real retry budget, not one attempt` | COVERED |
| 15 | H2 | `src/connect-pipeline.js:838` | `src/runtime/fsm.ts:280`、`src/connect/pipeline.ts:88` | 自动重试**不**重置预算 | `autoReconnect.maxAttempts is the real retry budget, not one attempt`；`a successful attach resets the retry budget exactly once`（T-d） | COVERED |
| 16 | H2 | `src/connect-pipeline.js:1114` | `src/connect/pipeline.ts:516`、`src/runtime/fsm.ts:61` | 是否重试只有一处决定；用户"否"是终局 | `a first connect that fails with error+close synchronously is not retried`；`connect.failed only arms a retry while the user still wants the link (H2)` | COVERED |
| 17 | H2 | `src/host-runtime.js:75` | `src/host-runtime.ts:193` | `connectCancelled` 字段存在且阻断自动重试 | `a first connect that fails with error+close synchronously is not retried`；`a host-key prompt that times out clears its pending state` | COVERED |
| 18 | H3 | `src/connect-pipeline.js:79` | `src/connect/guards.ts:3`、`:45` | `assertTransportOpen` 抛 typed `network` | `a transport dropped during bootstrap is a network failure and is retried` | COVERED |
| 19 | H3 | `src/connect-pipeline.js:89` | `src/connect/failures.ts:4`、`:25` | `normalizeConnectFailure` 把竞态失败改写成 dropped link | `a transport dropped during bootstrap is a network failure and is retried`；`a transport that closes while a host-key prompt is open is a dropped link and is retried` | COVERED |
| 20 | H3 | `src/connect-pipeline.js:249` | `src/connect/pipeline.ts:119`、`:280` | SSH 一开就挂断线监听（不等 UI ready） | `a transport dropped during bootstrap is a network failure and is retried` | COVERED |
| 21 | H3 | `src/connect-pipeline.js:851` | `src/connect/pipeline.ts:253` | `transportUp` 记录"曾经连上过" | `a transport dropped during bootstrap is a network failure and is retried` | COVERED |
| 22 | H3 | `src/connect-pipeline.js:878` | `src/connect/pipeline.ts:280` | 在后续步骤**之前**挂 close handler | `a transport dropped during bootstrap is a network failure and is retried` | COVERED |
| 23 | H3 | `src/connect-pipeline.js:1086` | `src/connect/pipeline.ts:489` | 失败归类用 `transportLost \|\| (transportUp && !connected)` | `a transport dropped during bootstrap is a network failure and is retried` | COVERED |
| 24 | H3 | `src/host-runtime.js:81` | `src/host-runtime.ts:199`、`src/runtime/fsm.ts:63` | `transportLost` 字段 | `a transport that closes while a host-key prompt is open is a dropped link and is retried` | COVERED |
| 25 | H4 | `src/connect-pipeline.js:74` | `src/connect/guards.ts:3`、`:40` | `assertStillWanted` 的判定（`linkTaken` 的四个条件） | `assertStillWanted rejects every taken link and accepts a live one`（T-e） | COVERED |
| 26 | H4 | `src/connect-pipeline.js:520` | `src/connect/transport.ts:109` | 工厂 await 期间被断开 → 关掉新 listener，不发布 | `a disconnect while the new listener is being created closes that listener`；`removing the host while the new listener is being created cannot leak it`；`shutting down during a tunnel rebuild closes the new listener` | COVERED |
| 27 | H4 | `src/connect-pipeline.js:749` | `src/connect/verify.ts:28` | token 交换后、探活窗口内再确认一次 | `a token exchange that lands after a user cancel never touches the closed tunnel`（T-c） | COVERED |
| 28 | H4 | `src/connect-pipeline.js:1066` | `src/connect/pipeline.ts:469` | store 写入（await）之后不得复活连接 | `a disconnect after the store write but before markConnected publishes nothing`（T-b） | COVERED |
| 29 | H4 | `src/connect-pipeline.js:1075` | `src/connect/pipeline.ts:478` | 发布前最后一道闸：不报已删除/已断开的连接 | `a disconnect during an unconfirmed stop never resurrects the connection`；`removing a host during an unconfirmed stop cannot resurrect it` | COVERED |
| 30 | H4 | `src/host-registry.js:139` | `src/host-registry.ts:180` | 删除主机时 `desired='idle'` + 取消定时器 | `a disconnect during an unconfirmed stop never resurrects the connection`；`removing a host during an unconfirmed stop cannot resurrect it` | COVERED |
| 31 | M1 | `src/host-lifecycle.js:499` | `src/host-lifecycle.ts:371`、`src/runtime/effects.ts:64` | teardown 主动结算挂起提问 | `a disconnect during a host-key prompt settles the connect immediately`；`a transport that closes while a host-key prompt is open is a dropped link and is retried` | COVERED |
| 32 | M1 | `src/prompts.js:108` | `src/prompts.ts:240` | 只有"仍是 live 的那个提问"才接受回答 | `answering a host-key prompt twice is refused: a late answer cannot revive a settled attempt`（T-a） | COVERED |
| 33 | M1 | `src/prompts.js:160` | `src/prompts.ts:297`、`:397` | `cancelHostKeyPrompt` 以 `false` 结算，让 `verifyHostKey` 立刻抛 | `a disconnect during a host-key prompt settles the connect immediately`；`a host-key prompt that times out clears its pending state` | COVERED |
| 34 | M2 | `src/remote-web.js:185` | `src/remote-web/start.ts:4`、`:196` | 启动失败要停掉已启动的进程 | `startRemoteWeb stops the process it already launched when the start fails` | COVERED |
| 35 | M2 | `src/remote-web.js:241` | `src/remote-web/start.ts:262` | 即使等就绪失败也保留已解析的 pid | `startRemoteWeb stops the process it already launched when the start fails` | COVERED |
| 36 | M3 | `src/remote-web.js:74` | `src/remote-web/start.ts:78` | profile dump 0600 + 两条路径都删除 | `buildBrowserCarrierProbe dumps the profile and only then writes the overlay` | COVERED |
| 37 | M3 | `src/remote-web.js:130` | `src/remote-web/start.ts:141` | `umask 077` 先于创建 log/state 目录 | `the launch script keeps its private files private and writes the registry atomically` | COVERED |
| 38 | M4 | `src/remote-web.js:132` | `src/remote-web/start.ts:143`、`src/remote-web/registry.ts:5` | registry 写临时文件再 rename | `the run registry is written through a temp file and renamed` | COVERED |
| 39 | M4 | `src/remote-web.js:278` | `src/remote-web/stop.ts:23` | pid 未知时用就绪行 + `/proc` 反查（最后手段） | `resolveRemoteWeb recovers a new pid from a fresh readiness line`；`stopRemoteWeb reports no-target when neither a pid nor a registry names the process` | COVERED |
| 40 | M4 | `src/remote-web.js:291` | `src/remote-web/stop.ts:40` | registry 优先；残缺记录仍给出 pid | `resolveRemoteWeb recovers a new pid from a fresh readiness line` | COVERED |
| 41 | M4 | `src/remote-web.js:298` | `src/remote-web/stop.ts:47`、`:5` | 只在确认停止且记录属于本 pid 时才删 registry | `stopRemoteWeb keeps the run registry when the process does not confirm its stop`；`stop from remote-unreachable clears the stale registry and releases the link` | COVERED |
| 42 | M4 | `src/remote-web.js:364` | `src/remote-web/registry.ts:64` | 解析残缺/旧格式记录 | `a truncated registry that names no complete pid yields no record`；`a run registry that does not parse still yields the pid it names` | COVERED |
| 43 | M4 | `src/remote-web.js:533` | `src/remote-web/registry.ts:174` | 写入侧同样 temp+rename | `the run registry is written through a temp file and renamed`；`the launch script keeps its private files private and writes the registry atomically` | COVERED |
| 44 | M6 | `src/ssh.js:471` | `src/ssh-sftp.ts:167` | Windows 元数据/shell 文件不落盘，且名字要报告 | `Windows metadata and shell shortcut names are never written into a download`；`saveRemoteTree leaves Windows metadata and shell shortcut files out` | COVERED |

**行数核对**：44 行 = B1×6、B4×1、B8×1、H1×4、H2×5、H3×7、H4×6、M1×3、M2×2、M3×2、M4×6、M6×1。
**标记核对**：当前 55 处标记（54 行去重，`src/connect/guards.ts:3` 同一行同时带 `(H4)` 与 `(H3)`）全部落在
上表某一行；其中 11 处是 P2/P5 拆分时复制到新模块头的重复标记（如 B8 的 `repair.ts:3`/`watchdog.ts:21`、
M4 的 `registry.ts:*`/`stop.ts:*`、H1 的 `fsm.ts:515`、M1 的 `effects.ts:64`、H2 的 `fsm.ts:61`）。
第 13–15 行共用一个 `(H2)` 注释（`fsm.ts:65`）说明规则，两个重置点作为代码行单列。

## 3. 补测（T-a…T-e）：把 4 PARTIAL + 1 UNCOVERED 变成真测试

五个都是纯单测、无新依赖、无外部进程；落地后上表逐行改为 COVERED。

| # | 补测编号 | 测试名 | 位置 | 保护的行 | 造法 |
|---|---|---|---|---|---|
| 1 | T-a | `answering a host-key prompt twice is refused: a late answer cannot revive a settled attempt` | `test/unit/host-key-prompt.test.ts` | #32（M1） | 起一次 `fingerprint-pending`：先接受一次，再在同一 tick 重复回答 → 断言第二次 `invalid-input`、store 只写一次 pin；第二段让 `hostKeyConfirmTimeoutMs` 到期，再用旧回答 → 断言状态/错误/预算/pin 全部不变 |
| 2 | T-b | `a disconnect after the store write but before markConnected publishes nothing` | `test/unit/connect-lifecycle.test.ts` | #28（H4） | 假 `store.patchHost` 在 `lastOpenedAt` 那次写入上挂起，期间 `disconnect`，再放行 → 断言 `disconnected`、`activeHostId` 未变、无 `connected` 帧、listener 已关 |
| 3 | T-c | `a token exchange that lands after a user cancel never touches the closed tunnel` | `test/unit/connect-lifecycle.test.ts` | #27（H4） | 假 `exchange` 挂起期间 `disconnect` → 放行 token 交换 → 断言 listener 保持关闭且 `close()` 未被再次调用、`uiReady` 仍 false、未走到 store 写入 |
| 4 | T-d | `a successful attach resets the retry budget exactly once` | `test/unit/connect-lifecycle.test.ts` | #14（H2） | 先成功连接，再断开链路让两次重试失败，然后放行第三次 → 以访问器统计 `reconnectAttempts` 的 `非零 → 0` 写入，断言恰好 1 次、`reconnectTimer` 为 null |
| 5 | T-e | `assertStillWanted rejects every taken link and accepts a live one` | `test/unit/link-guard.test.ts` | #25（H4） | 表驱动四个 `linkTaken` 条件（disposed、closing、`desired!=='connected'`、离开 registry）各一例，断言 `LinkCancelled`；再断言 live 链接放行、判定只读不写 |

## 4. 空 catch 与 `swallow-ok:`（review 第 8 条的另一半）

- **规则**：**空 `catch` body（裸的，或只有注释的）必须带 `// swallow-ok: <理由>`**，理由至少两个词。
  非空 body 不受这条规则管（它归 `test/unit/guards.test.ts` 的 `swallow-guard`：把未知失败包装成
  typed reason 时必须可区分或同样带 `swallow-ok:`）。
- **机验**：`scripts/check-repo.mjs` 的 `4b. Empty catch hygiene` 扫描 `src/**/*.ts`（源码，不是 `dist/`
  产物），报告 `${rel}:${line} — empty catch without "// swallow-ok: <reason>"`。三种写法都覆盖：
  `catch {}`、`catch (e) {}`、`catch { /* 只注释 */ }`；`.catch(() => {})` 与有语句的 catch 不误报。
- **标记窗口**：catch body 内、catch 上方**连续注释块**（最多 5 行）、或该 `try` 上方连续注释块（最多 5 行）；
  空行或代码行会截断窗口，避免上一段的注释"隔空"为这一处担保。
- **当前状态**：`src/**/*.ts` 共 42 处空 catch；治理前为 19 裸 + 23 仅注释，现在 **42 处全部带 `swallow-ok:`**。
  对照 review 基线的 34 处未标记（17 裸 + 17 仅注释）：本次处置 36 处（34 处基线 + P4 SSE 拆通道后新增的
  2 处日志通道驱逐/关闭），其余 6 处此前已带标记。全部只加注释，**零逻辑改动**。
- **确认**：`test/unit/guards.test.ts` 的 `swallow-ok` 扫描器已按 P8 迁到 `src/**/*.ts`（不再是产物），
  并在本文件 §4 与 `docs/implementation.md` 同步说明。
