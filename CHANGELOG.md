# Changelog

> **English abstract.** All notable, user-visible changes to `dsh-remote-go` are recorded here, newest first.
> The format follows Keep a Changelog 1.1.0 and versions follow Semantic Versioning 2.0.0. Entries are written
> in Chinese (the project's primary language) and describe user-visible behavior rather than individual
> commits. Dates use `YYYY-MM-DD`; `0.1.0` is the current baseline and has not been published to npm yet.

本文件记录本项目的所有重要变更。格式基于 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。日期为 `YYYY-MM-DD`。

变更按用户可感知的行为归纳，不逐条对应 commit；同一版本内按「新增 / 变更 / 修复 / 安全」分组，空分组不列出。

## [Unreleased]

### 新增

- 镜像会话的**写入租约现在是双向的**：插件会发布自己的 `{ writer, epoch, expiresAt, sessionKey }`
  （拿到租约时、心跳续约时发布，断开时写墓碑），并**读取并遵守**远端权威的校验结果——过期 epoch / 会话密钥不符 /
  可疑跳变都会被拒绝，被拒绝的一方转为只读（`reason.code="fenced"`，`cursor` 不推进，历史仍可读）。
  可调：`epochJumpLimit`（默认 1000）限制可信的 epoch 跳变窗口，超出者被拒绝并记录为 suspicious，
  不会被采纳——避免「发布一个巨大 epoch」把真正的写入者永久围栏。
  **重要**：**远端的校验逻辑目前只由模拟远端实现（`e2e/sim`），未改造的真实 DSH 没有这段代码**。因此
  「两个客户端只有一个能写」这一效果**只在模拟远端下成立**；对真实远端而言它是设计而非已交付的保证。
  这只是 L3 的前置条件之一，L3（流式/输入转发/审批）仍未实现；真实性绑定也仍只到「同一文件」层面，
  详见 `docs/session-design.md` §6.2 与 §11 #9-#11。

### 变更

- 新增 L3 第一阶段的**轮询跟随**（`mirrorStream`，**默认关闭**）：开启后，远端会话在主机会话连接期间新增的记录会
  自动追加到本地镜像，无需手动同步。远端助手在远端侧拒绝过期 epoch；本地以描述符里的 `cursor` 为唯一持久真相，
  字节偏移只存内存且仅在游标真正前进后推进，因此重启与重连都只会重读、不会跳过或重复。关闭时行为与之前完全相同。


- 修复删除主机后镜像「复活」的缺陷：主机删除现在与镜像同步共用同一条每主机队列（`src/mirror-writer.js:54`），
  并且删除时在第一个 `await` 之前给该主机的描述符写入打上墓碑（`src/service.js:384`，由 `src/mirror-writer.js:35`
  在排队操作内部检查）——因此同步进行中删除主机不会再让它的镜像会话重新出现。同时移除了 reconcile 的过期快照回退
  （`current.length > 0 ? current : existing`），它会在描述符被清空后用删除前的快照重建。


- 修复镜像描述符的并发写入：`reconcile` 与历史回放两路写入各自读快照再整体写回，可能互相覆盖 `cursor`
  （lost update）。现在所有描述符变更走同一个单写者（读 → 应用增量 → 持久化，每个主机串行），
  且 `cursor` / `epoch` / 冲突计数只增不减。

- 修复「内部缺陷被当成远端原因」的静默故障：历史读取里插件自己抛出的异常（例如 TDZ `ReferenceError`、非预期结构）
  现在分类为 `reason.code="internal-error"` + `internal: true` + `internalError {name, message, stack}`
  （`src/history.js:568`），在 `logs` 里记 error 级日志并单独计入 `history.internalErrors`（`src/service.js:965`），
  不再伪装成 `read-failed` 这样的远端条件。堆栈只进日志、不写入描述符（`src/service.js:968-972`）。
  同时新增默认违规的防回归扫描器 `test/unit/swallow-guard.test.js`：任何产出 `reason:` 的 `catch` 都必须可区分
  （`internal-error` / 真正的 error 日志 / 重新抛出），或带 `// swallow-ok: <≥2 词>` 标记并被评审接受。

### 工程与仓库治理

面向贡献者与发布流程，不改变产品行为：

- 引入 Prettier 作为唯一格式化工具（`pnpm run format` / `format:check`，已接入 CI），
  并用 `.git-blame-ignore-revs` 让格式提交不污染 `git blame`。
- 新增零依赖的覆盖率门禁 `pnpm run test:coverage`（行 ≥ 85%、分支 ≥ 70%、函数 ≥ 80%）；
  当前基线 92.01 / 78.37 / 91.01（排除 `vendor/` 与测试自身）。
- 新增仓库规范检查 `pnpm run lint`（必需文件、包元数据、版本一致性、换行/空白、密钥泄漏、workflow 约定）
  与 `pnpm run verify` 聚合门禁。
- 新增 CI 工作流 `Repository conventions` / `Integration tests` / `CodeQL` / `Release`（`v*` 标签触发，带 tag 与
  版本一致性断言、provenance 发布与 GitHub Release），并补充 issue/PR 模板、Dependabot、CODEOWNERS。
  分支保护由 ruleset「main protection」定义：8 项必需检查、`strict`、无绕过者。
- 社区健康文件：`CONTRIBUTING`、`CODE_OF_CONDUCT`、`SECURITY`、`CHANGELOG`。
- 仓库行尾统一为 LF（`.gitattributes`），Windows 入口脚本保持 CRLF。
- E2E 工具链去机器化：不再硬编码个人路径或默认测试主机，改用 `E2E_SSH_ADDRESS` / `E2E_CHROME` /
  `E2E_NODE` / `DSH_PNPM` / `PNPM_EXE` 与 PATH 解析。
- 安全：清除已提交的 E2E 证据中的 cookie/token 值；文档与默认值不再包含测试主机地址。
- 修复：接入向导的地址输入提示不再展示维护者自己的 SSH 别名，改用通用示例（`ubuntu@192.0.2.10` / `my-server`）。

## [0.1.0] - 2026-11-11

首个版本（**尚未发布到 npm**，也无对应 tag）：在本地 DSH 的全局面板里，通过 SSH 整页使用服务器上的 DSH。

### 新增

- **插件形态**：单包 DSH bundle，Host 半端（`src/`，经 `index.js` 导出）与 Client 半端（`client.js`，无构建的单文件浏览器模块）
  两半共存，由 `cordis.patch.yml` 声明安装；**不占用侧边栏入口**，入口在设置页与面板内。
- **设置页「远程主机」**：主机清单（含状态、远端版本、上次打开时间）、添加 / 编辑 / 删除、多主机切换、连接 / 断开、
  诊断入口、插件设置与「打开远程界面」都在设置里完成。
- **接入向导 3 步**：SSH 信息 → 连接测试（网络 → 认证 → 主机指纹 → 系统信息）→ 远端探测与完成。
- **SSH 接入**：`~/.ssh/config` 别名自动发现与目标解析、`known_hosts` 只读解析（跳过哈希条目，只报数不猜）、
  SSH Agent / 密钥文件 / 一次性密码认证（密码不落盘、密钥不上传）、跳板机（跳板 SSH → `forwardOut` → 目标 SSH）。
- **主机指纹管理**：首次连接显式确认、接受后记录 pin、指纹变化强提示并阻断、`strict` 策略直接拒绝未记录的主机。
- **全局面板承载远端界面**：整页呈现远端 DSH 自己的 Web 界面（同站 loopback iframe），会话、审批、文件、终端、插件、凭据、
  日志都由远端 DSH 提供；本地只负责主机清单、连接与状态。
- **面板左侧「工作区」栏**：列出「本地工作区」与按远端主机分组的工作区（分别读取本机与远端 DSH 的
  `storages/workspace.json`），点击本地工作区回到本地会话，点击远端工作区打开对应主机面板。
- **视窗工具条**：状态点、重连、刷新、切换主机、在新窗口打开（iframe 受限时的逃生通道）、返回。
- **连接状态与恢复**：分阶段进度（SSH → 探测 → 自举 → 启动 → 隧道 → 校验）、断线自动重连与断线横幅、
  分类错误卡片（网络 / 认证 / 指纹 / 远端服务 / 远端界面 / 版本），每类带「下一步」。
- **诊断**：9 项检查表（SSH 可达性、认证、主机指纹、隧道、远端服务、远端界面可达、版本、凭据等）+ 一键复制脱敏诊断。
- **远端环境自举**：T0 复用同版本 DSH / T0-local 复用此前准备的隔离运行时 / T1 `npx` 精确版本 / T2 用户目录隔离安装 /
  T3 下载官方 Node（SHA-256 校验）后安装；T5 明确失败并给出可复制的准备命令，不假装成功。全部产物在用户目录，无需 root。
- **版本一致性**：目标版本取本机 DSH 版本；安装与启动都写精确版本，不一致时给出显式选择（准备同版本 / 沿用远端 / 取消），
  不静默混用。
- **远端存活策略（按主机）**：保持运行（默认）/ 退出即停 / 空闲数分钟后停止；关闭视窗只关闭本地承载，远端任务继续。
- **隧道收养**：本地重启后复用仍在运行的远端实例（run registry + 日志 URL + pid 与 HTTP 探测），避免重复拉起。
- **设置项**：窗口与关闭行为、SSH 默认值、自动重连、主机指纹策略、是否保存访问令牌（默认不保存）、自举参数。
- **双语界面**：中文 / English 文案与插件市场元数据（`locale/`）。
- **工程与发布**：零运行时依赖、无安装期生命周期脚本（`ssh2` 由 `scripts/build-vendor.mjs` 打包为
  `vendor/ssh2.bundle.cjs` 随包分发）；`scripts/` 提供语法、workflow YAML、市场条目与打包内容校验；单元测试覆盖
  Host 与 Client；`test/e2e/` 提供真实 SSH + 真实远端 DSH + 无头 Chrome 的端到端验收；发布到 npm 与插件市场的路径见
  `docs/publish.md`。
- **持续集成**：ubuntu / windows 双平台 × Node 24 跑单元测试与打包校验，并有手动触发的真实测试主机 E2E 工作流。
- **文档**：产品设计（`docs/design.md`）、实现说明（`docs/implementation.md`）、本地 API 契约（`docs/api.md`）、
  发布与插件市场（`docs/publish.md`）、同类项目调研（`docs/research-*.md`），以及仓库治理文档
  （[CONTRIBUTING](CONTRIBUTING.md)、[CODE_OF_CONDUCT](CODE_OF_CONDUCT.md)、[SECURITY](SECURITY.md)）。

### 变更

- 本地形态按产品调整落地：不再使用「远程入口」名称、不再占用侧边栏入口，改为**设置页「远程主机」+ 全局面板**。
- 面板内新增工作区区分：本地工作区与远端工作区并列展示（属于插件面板，不修改 DSH 内置侧边栏）。
- 插件市场显示名统一为 `dsh remote go`，本地界面统一称「远程主机（Remote hosts）」。

### 修复

- 连接期间发生的 SSH 错误不再导致 Host 侧崩溃，改为分类错误返回并在界面展示原因与下一步。
- 修复 CI 在干净 runner 上无法校验 workflow YAML 的问题（补齐 YAML 解析依赖）。

### 安全

- **零运行时依赖 + 无安装期脚本**：安装不会执行第三方代码；供应链面收敛。
- **回环硬规则**：远端 DSH 只绑 `127.0.0.1`，本地隧道也只监听 `127.0.0.1`，本地不监听公网地址。
- **凭据最小化**：SSH 密码仅用于本次连接（内存），密钥不上传；访问令牌默认只在内存，用户显式开启后才以 0600 保存；
  本地持久化目录 0700、文件 0600 且为原子写。
- **主机指纹**：首次确认、变化阻断、`strict` 策略可选，避免中间人替换主机密钥。
- **本地 HTTP API 鉴权**：要求自定义请求头 + 同源 `Origin` + 拒绝 `sec-fetch-site: cross-site`；`/events`（EventSource
  无法加头）只做 Origin 栅栏；面板只接受 `http://127.0.0.1:<port>` 形式的 iframe URL，防止任意 URL 被嵌入或令牌外泄。
- **自举只走白名单模板**：Node 下载、`npx` 精确版本、隔离安装三类固定命令，不接受用户拼接的任意 shell；下载校验 SHA-256。
- **脱敏**：诊断导出默认屏蔽 token、密码、私钥与家目录，降低贴日志时的泄漏风险。

[Unreleased]: https://github.com/Solaris136/dsh-remote-go/commits/main
