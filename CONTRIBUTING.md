# 贡献指南

> **English abstract.** `dsh-remote-go` is a DSH plugin that opens a remote DSH inside a full-page local
> panel over SSH, with host management, connection diagnostics, remote bootstrap and version parity. This
> guide covers local setup (Node 24 + pnpm 11, install with `--ignore-scripts`), the canonical checks
> (`pnpm run verify`), Conventional Commits, the PR flow (fork → branch → PR against `main`, squash merge),
> review expectations, code style, and private security reporting. The rest is written in Chinese.

感谢你愿意参与 `dsh-remote-go`（「dsh remote go」）。本文说明本地开发、提交与评审的约定；产品与设计背景见
[README](README.md)、[设计文档](docs/design.md) 与 [实现说明](docs/implementation.md)。

## 1. 开始之前

- 小修小补（错别字、明确的 bug 修复）可以直接提 PR。
- 行为变更、新能力、契约调整（`docs/api.md`）、依赖变动请先开 issue 说清问题与方案，避免重复劳动。
- 本项目的核心取舍是「**薄客户端 + 零运行时依赖 + 零安装脚本**」（见 README「关键决策」），评审会以此为准绳。

## 2. 开发环境

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node.js | 24 或更高 | `engines.node` 为 `>=24`；单元测试与校验脚本都在 Node 24 上验证，CI 只用 Node 24 |
| pnpm | 11.x | `package.json` 用 `packageManager: pnpm@11.x` 固定版本，`corepack enable` 即对齐；CI 用 `pnpm/action-setup` |
| SSH 测试主机 | 可选 | 仅 `test:e2e` 需要：真实 SSH + Linux 远端 + 可用的远端 DSH（`E2E_SSH_ADDRESS`，必填） |
| Chrome / Edge | 可选 | `test:e2e` 与 `test:integration` 的浏览器套件需要（`CHROME_PATH` / `E2E_CHROME` 可覆盖） |

首次检出后安装依赖：

```bash
corepack enable                                         # 按 packageManager 固定 pnpm 11
pnpm install --frozen-lockfile --ignore-scripts
```

`--ignore-scripts` 是刻意的：本仓库**没有安装期生命周期脚本**（无 `postinstall` / `preinstall` / `prepare`），
唯一挂载的钩子 `prepack` 只做只读校验（`market-entry.mjs --check`）。发布包 `dependencies` 为空，`ssh2` 以预打包产物
`vendor/ssh2.bundle.cjs` 随包分发。因此：

- 安装过程不会执行第三方代码（供应链更可控，CI 与插件市场安装更稳定）；
- **不要**新增 `postinstall` / `preinstall` / `prepare` 等生命周期脚本；需要生成产物时用显式脚本（如
  `pnpm run build:vendor`）并在 PR 里说明原因；
- 新增或升级 `devDependencies` 时，请先用普通 `pnpm install` 更新 `pnpm-lock.yaml`，再在干净环境用
  `--frozen-lockfile` 复验；**不要手改 lockfile**。

## 3. 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm run verify` | 提交前必跑；等价于 CI 门禁（组成见下） |
| `pnpm run lint` | `node scripts/check-repo.mjs`，检查仓库级约定 |
| `pnpm run format` | 用 Prettier 按 `.prettierrc.json` 格式化（提交前跑） |
| `pnpm run format:check` | 只检查格式，不改文件（CI 会跑） |
| `pnpm run check:syntax` | 解析全部 JS/MJS，确认无语法错误 |
| `pnpm run check:workflows` | 用真实 YAML 解析器校验 `.github/workflows/*.yml` |
| `pnpm run market:check` | 校验包元数据、运行时文件与 format-1 市场索引条目 |
| `pnpm run pack:check` | 校验 `files[]` 覆盖与 `pnpm pack` 产物内容 |
| `pnpm run test:unit` | `node --test "test/unit/*.test.js"`（Host + Client，无需网络 / SSH） |
| `pnpm run test:integration` | 集成/E2E（模拟远端 + `Web E2E` + `Desktop E2E`；缺 harness/浏览器时跳过，`DSH_E2E_STRICT=1` 下改为失败） |
| `pnpm run test:coverage` | 单元测试 + 覆盖率门禁（行 ≥ 85%、分支 ≥ 70%、函数 ≥ 80%，不含 `vendor/` 与自己） |
| `pnpm run check:pr-title` | 按 Conventional Commits 校验 PR 标题（CI 对 PR 强制，见 §5） |
| `pnpm run build:vendor` | 重新打包 `vendor/ssh2.bundle.cjs`（改动 ssh2 版本时） |
| `pnpm run test:e2e` | 两个端到端套件（见下），需要 SSH 主机、Chrome 或可用的 pnpm；不在常规 PR CI 中运行 |

`pnpm run verify` 依次执行：`lint` + `format:check` + `check:syntax` + `check:workflows` + `market:check` +
`pack:check` + `test:unit` + `test:integration`，是本地与 CI 的同一套门禁；只跑单测而不跑校验脚本的 PR 会被 CI 打回。
（覆盖率门禁 `test:coverage` 不在 `verify` 里，由 CI 的 `Repository conventions` 作业执行。）

代码风格由 Prettier 统一（`.prettierrc.json`：无分号、单引号、行宽 120、ES 尾逗号、LF）。不要手工调格式：
改完代码跑 `pnpm run format` 即可。Markdown 由人换行（列在 `.prettierignore` 中），不会被格式化工具重排。

### 端到端测试（可选）

`pnpm run test:e2e` 由两个套件组成，都需要 `e2e/control` 下已准备好的隔离 control DSH 运行时
（见 [e2e/remote/README.md](e2e/remote/README.md)）：

- `test/e2e/plugin.e2e.js`：真实 SSH 主机（**必须**设置 `E2E_SSH_ADDRESS`，取 SSH 别名或 `user@host`；未设置时该套件
  会被跳过）+ 本机 Chrome/Edge（`E2E_CHROME` 可覆盖路径）；
- `test/e2e/publish.e2e.js`：把 tarball 装进干净的 DSH profile 验证发布路径，需要 PATH 上有 `pnpm`
  （或用 `DSH_PNPM` / `PNPM_EXE` 指定入口）。

E2E 会连接真实服务器、启动与停止远端 DSH，并写出报告、截图与证据文件。**提交前务必确认这些证据不含令牌、密码、
私钥或真实主机名/地址**；`e2e/remote/evidence` 下的文件尤其需要人工复核（详见 [SECURITY.md](SECURITY.md)）。

## 4. 提交信息（Conventional Commits）

格式：`type(scope): subject`

- `type` 取值：`build`、`chore`、`ci`、`docs`、`feat`、`fix`、`perf`、`refactor`、`revert`、`style`、`test`。
- `scope` 可选，取影响面最小者：`host`、`client`、`ssh`、`tunnel`、`bootstrap`、`ci`、`docs`、`deps` 等；
  只允许小写字母、数字与连字符。
- `subject` 用祈使句，小写开头（专有名词除外），**结尾不加句号**，整条标题（含 `type(scope): `）**不超过 72 个字符**。
- 需要解释「为什么」时，空一行写正文；破坏性变更用 `BREAKING CHANGE:` 页脚，或写成 `feat(host)!: ...`。
- 合并前记得把标题从 `WIP`/草稿状态改成正式标题——CI 会拒绝以 `WIP` 开头的标题。

| type | 用途 |
|---|---|
| `feat` | 用户可见的新能力 |
| `fix` | 用户可见的缺陷修复 |
| `perf` | 不改变行为、只改善性能 |
| `refactor` | 不改变行为的结构整理 |
| `docs` | 仅文档 |
| `test` | 仅测试 |
| `build` | 打包/构建/依赖产物（含 `vendor/`、lockfile） |
| `ci` | `.github/workflows` 与 CI 脚本 |
| `chore` | 杂项维护（版本号、仓库元数据） |
| `style` | 纯格式（空格、换行、引号），不改变语义 |
| `revert` | 回退既有提交，正文注明被回退的 commit |

## 5. 分支与 PR

1. Fork 仓库，从 `main` 创建分支：`<type>/<short-slug>`，例如 `feat/settings-remote-hosts`、`fix/ssh-timeout`。
2. 本地跑通 `pnpm run verify`。
3. 向 `main` 提 PR。保持单一主题：一个 PR 解决一个问题，避免顺手重排整个文件。
4. 合并方式是 **squash merge**：`main` 上每个 PR 恰好一个提交，所以 **PR 标题必须是合规的 Conventional Commit**
   —— squash 会拿 PR 标题当提交信息，PR 内部的单条提交信息只作参考；CI 里 `scripts/check-pr-title.mjs` 会直接
   校验标题格式与长度。
5. 评审意见用追加提交处理即可，不必强行 rebase；合并前把 PR 标题与最终变更对齐。
6. 与 `main` 冲突时 rebase 到最新 `main`，然后重跑 `pnpm run verify`。

本地可以先自查标题：

```bash
node scripts/check-pr-title.mjs "feat(panel): add SSH tunnel keepalive backoff"
```

### CI 检查项

PR 触发 `.github/workflows/ci.yml`，只有两个作业：

- **Verify (ubuntu-latest)** —— `pnpm run lint` + `format:check` + `check:syntax` + `check:workflows`、
  PR 标题校验（`scripts/check-pr-title.mjs`，dependabot 除外）、`test:coverage` 覆盖率门禁、
  模拟远端集成/E2E（`test/integration`）、市场条目与 `files[]` 校验、`pnpm pack` + tarball 校验并上传 artifact
- **Tests (windows-latest, Node 24)** —— 单元测试 + 模拟远端集成/E2E（路径与 SSH 配置对平台敏感，Windows 单独跑）

真实浏览器验收由 `.github/workflows/acceptance.yml`（Web + Desktop E2E）**夜间定时 + 手动**运行，
真实主机 E2E 由 `.github/workflows/e2e.yml` **手动触发**——两者都不构成 PR 门禁（真实 Chrome/Electron
对 runner 负载敏感，偶发超时不应阻塞合并）。第三项**必需检查**是 `Analyze (javascript-typescript)`（`codeql.yml`）。

### 仓库规则（已在仓库设置中启用）

- **`main` 受保护**（ruleset「main protection」，`strict` = 开启、**无绕过者**）：禁止删除与强推、要求线性历史、
  要求通过 PR 合并，并且必须通过 **3 项必需检查**——`Verify (ubuntu-latest)`、
  `Tests (windows-latest, Node 24)`、`Analyze (javascript-typescript)`。
  `strict` 表示分支必须与 `main` 同步后才算通过（需要先 rebase/合并最新 `main`）。
- **只允许 squash merge**：合并后自动删除来源分支；PR 标题即最终提交标题。
- **`v*` 标签受保护**（ruleset「release tags」，无绕过者）：禁止删除与移动，发布标签一旦推送即不可变。
- **安全相关**：Dependabot 安全更新自动开 PR；CodeQL 在 PR 上扫描；secret scanning 与 push protection 已开启——
  如果推送被拒绝并提示检测到密钥，请按 [SECURITY.md](SECURITY.md) 处理并立即轮换该凭据。

## 6. 评审要求

评审看「可验证」，不看风格口味。合并前置条件：

- **行为变更必须带测试**：修 bug 先写能复现的失败用例；新增分支逻辑补 `test/unit` 用例（`node:test`，纯逻辑优先，
  需要 I/O 时用测试内的假 SSH / 假 HTTP 服务，不依赖外网）。
- **用户可见变更必须带文档**：改界面文案、设置项、错误分类、命令、安装方式时，同步更新 README 与 `docs/`，
  并在 `CHANGELOG.md` 的 `[Unreleased]` 下补一行。
- **不新增运行时依赖**：零运行时依赖是本项目的卖点；确需新增时先开 issue 说明理由与替代方案，评审通过后再动
  `package.json`。`ssh2` 走 vendored 打包，不作为运行时依赖发布。
- **不放密钥**：代码、测试夹具、E2E 证据、截图、日志都不得包含 token、密码、私钥、真实主机名/IP 或内网地址；
  需要示例时用明显的假值（如 `example.invalid`、`127.0.0.1`）。
- **不做无关改动**：不顺手升级依赖、不重排格式、不改与本 PR 无关的文档。
- **契约要保持稳定**：Host↔Client 的 HTTP 契约见 `docs/api.md`；改契约需同步文档、`client.js` 与对应测试。

## 7. 代码风格

格式由 **Prettier** 统一（`package.json` 的 devDependency，配置在 `.prettierrc.json`：无分号、单引号、行宽 120、
ES 尾逗号、LF）；提交前跑 `pnpm run format`，不要手工调格式，也不要引入第二个格式化工具。Markdown 列在
`.prettierignore` 里，由人换行，不会被重排。`pnpm run lint`（`scripts/check-repo.mjs`）另做仓库级校验。

- ESM（`"type": "module"`），优先 Node 内置模块；Host 半端不 import DSH 内部包，避免版本耦合。
- 2 空格缩进；字符串用单引号（需要内嵌 JSON 或本身含单引号时用双引号）；**语句末尾不加分号**。
- LF 换行、文件末尾保留一个换行、UTF-8 编码；这些已由 `.gitattributes` / `.editorconfig` 固定，仅 `.cmd` / `.ps1`
  在 Windows 工作区保留 CRLF。代码文件不留行尾空格；Markdown 用空行分段，不要依赖行尾双空格断开段落。
- 错误统一用 `src/errors.js` 的分类构造，附中英文案与「下一步」；不要抛裸字符串。
- 用户可见文案必须中英双语，`locale/` 与 `client.js` 词典保持对齐（单测会校验）。
- 注释多解释「为什么」而非「是什么」；文档与注释控制在 120 列以内硬换行。
- `client.js` 是单文件、无构建的浏览器半端：保持可读，不要引入打包步骤，也不要写 `import`。

## 8. Windows 平台约定

> **English abstract.** Every `spawn` / `spawnSync` / `execFile` / `exec` in `test/**` and `src/**` must pass
> `windowsHide: true`, avoid `shell: true` and `.cmd` shims, and kill process trees with native means. Each
> short-lived child would otherwise flash a console window in the user's session.

本插件与它的测试会在 Windows 上启动很多短命子进程（`dsh`、`pnpm`、浏览器、Electron、`taskkill`）。每漏一个
`windowsHide`，维护者的桌面上就会闪一次黑框，所以这是硬性约定：

- `test/**` 与 `src/**` 里**所有** `spawn` / `spawnSync` / `execFile` / `exec` 都传 `windowsHide: true`
  （单元测试 `test/unit/e2e-child-process.test.js` 会扫描源码，漏一个就失败）。
- 不要用 `shell: true`，它会绕 `cmd.exe`（多一层窗口与转义风险）。优先直接跑真实二进制，或
  `process.execPath` + 入口脚本（如 `node <pnpm.cjs>`、`node <dsh>/lib/bin.js`）。
- 杀掉整棵进程树用原生手段（遍历 `Win32_Process` + `Stop-Process`，或 Node 里的 `taskkill /T`），
  不要在脚本里 `Start-Process taskkill`。
- 非 Windows 平台不受影响：这些参数在 POSIX 上被忽略。

## 9. 测试基础设施约定（四条硬规则）

> **English abstract.** Four rules, each derived from a real failure or CI incident: (1) a wait predicate must cover
> **every** state the assertions after it require; (2) an activation must use the **same** locator as its readiness
> check, click via the DOM, and be verified by its effect; (3) a service double must **enforce** the host contract
> instead of accepting any shape; (4) a `catch` that turns an unknown failure into a normal-looking state must log at
> error level and stay distinguishable — never let an internal defect masquerade as a remote condition.

这四条不是风格偏好，而是过去几个 CI 失败与一次「全绿的静默故障」的根因。改 `test/**` 与 `src/**` 时请对照执行：

1. **等待谓词必须覆盖其后的断言（wait predicate ⊇ assertion）。**
   `pollUntil` / `while` 轮询 / `waitForFunction` 返回真之后的第一段断言，涉及的每一个状态都必须在谓词里出现过。
   反例：`history.e2e.js` 只等 `cursor === 2`，随后断言日志含 `gap-unfilled`——日志在持久化之后才写，于是
   Windows 上偶发失败、ubuntu 上通过。现在谓词同时覆盖 cursor、level、reason 与日志行。
   写测试时先写下断言，再把断言里的每个条件抄进谓词；不要用「再睡一会儿」掩盖窗口。
   这条由 `test/unit/predicate-guard.test.js` 强制：它扫描 `test/integration/*.e2e.js` 的
   `waitForMirrors` / `pollUntil` 谓词，与紧随其后 `assert.*` 读取的字段比对，缺字段就按 `file:line` 失败；
   少数「瞬时快照」等待（断言读的是谓词匹配到的同一份快照）在 `TRANSIENT_SNAPSHOT_WAITS` 里逐条登记理由，
   新增违规仍然失败，登记失效（违规消失）也会失败。

2. **激活路径只能有一套定位器，且必须验证效果（one locator, DOM click, verified effect）。**
   就绪检查与点击必须用同一个定位器（`test/integration/activation.js` 的 `activateRowInPage` 用 `*` 遍历），
   否则「元素在」与「能点」会分叉，产生 `found the … entry but could not activate it`。
   点击必须是 DOM `click()`（坐标点击会被任何浮层吞掉），点击前检查 `aria-disabled` / `pointer-events` /
   有无布局盒；点击**必须**用有界轮询确认效果（目标区域真的挂载 / 对话框真的关闭），失败时重新定位并重试，
   错误信息里打印 url、对话框数量、命中节点的 tag/role 与被什么覆盖。
   遮挡判定必须**同源区分**：`elementFromPoint` 命中同一对话框内的节点（例如对话框自己的关闭按钮被自身背板
   覆盖）**不算**外部遮挡——否则会拒绝点击本对话框的关闭控件，浮层永远关不掉；只有命中**另一个**对话框或
   无关浮层才算遮挡。命中同源时照常点击，由「效果已验证」兜底。不要再写第二套 `clickByText`。

3. **测试替身要比宿主更严格，而不是更宽松（fakes enforce the host contract）。**
   替身接受的形状必须与真实宿主一致：`sessions.create` 在 `meta.isSeeded` 时必须要求显式 `seed` 与
   `inheritedEventCount`（用 `test/helpers/fake-sessions.js` 的 `assertSeededCreateOptions`），重复 id 要抛错，
   surface 事件必须带 intent，`Session` **没有** `events` 数组。反例：一个忽略 `create` 选项的替身让「每次镜像
   会话创建都失败」这样的生产缺陷一路绿灯通过 CI。
   需要钩子就放在替身里，**不要**为此给生产代码加分支或导出。

4. **不要把内部缺陷伪装成正常/远端状态（never swallow an internal defect into a plausible state）。**
   一个把未知异常转成「看起来正常」的结果的 `catch`，必须**在 error 级别记录**并且**可区分**。
   判定的结构性做法：`try` 的边界就是 I/O 调用本身（只包住 `await ssh.exec(...)` 这类传输调用），
   这样只有传输失败才会落到远端原因；其它语句（拼路径、解析、映射）抛出的异常一律是插件自己的缺陷，
   必须走独立的类型化原因 + `error` 日志（含堆栈），**不能**复用远端原因。
   反例（本约定的来源）：L3 流式回放尝试里，`streamFile` 在 `const` 之前被读取（TDZ `ReferenceError`），
   外层的兜底 `catch` 把**任意**异常映射成 `read-failed`——一个可信的远端原因。结果是历史回放被静默关闭，
   而所有测试依然全绿；只有真机上「历史永远为空」暴露了它。现在这种精况会变成
   `reason.code="internal-error"` + `error` 级日志（异常名/消息/堆栈）+ `history.internalErrors` 计数。
   允许的例外只有一种，且必须写明理由：
   ```js
   try {
     result = await ssh.exec(command) // try 体只有传输调用
   } catch {
     // swallow-ok: read-failed — try body is only ssh.exec, a rejection is transport
     return { ok: false, reason: 'read-failed' }
   }
   ```
   `// swallow-ok: <理由>` 标记会被 `test/unit/swallow-guard.test.js` 识别：它**递归**扫描 `src/**/*.js`，
   把**任何**「产出 `reason:` 字段」的 `catch` 都当作违规（默认违规，而不是维护一份远端原因黑名单——
   变量、helper 调用、新造的名字都逃不掉），除非该 `catch` 已经**可区分**（出现 `internal-error` /
   `internalHistoryFault(` / 真正的 `#log(…, 'error', …)` 或 `logger.error(` 调用 / 重新抛出），
   或者带有该标记。判定前会**先剥离注释**，所以注释里的 "throw"、"error" 不算数。
   标记后**必须**跟至少两个词的理由，空的 `// swallow-ok` 不生效。不要用它掩盖一个本该 log 的分支。

## 10. 安全相关

- 安全漏洞请**私下**报告，不要开公开 issue；渠道、时限与范围见 [SECURITY.md](SECURITY.md)。
- 讨论安全问题时（哪怕只是怀疑）也不要贴真实凭据，用占位值复述现象。
- 诊断导出默认脱敏（token / 密码 / 私钥 / 家目录），但仍可能包含主机名与路径，转贴前请自行复核。
- 改动 SSH 认证、主机指纹策略、隧道监听地址、本地 HTTP API 鉴权、回环 URL 校验、远端自举命令模板时，
  请在 PR 描述里写明威胁模型与验证方式。

## 11. 行为准则与许可

- 参与即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)（Contributor Covenant 2.1）。
- 贡献按 [MIT](LICENSE) 授权发布。
- 拿不准的事先开 issue 问一句，比提一个方向错误的 PR 更省时间。
