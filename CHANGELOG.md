# Changelog

> **English abstract.** All notable, user-visible changes to `dsh-remote-go` are recorded here, newest first.
> The format follows Keep a Changelog 1.1.0 and versions follow Semantic Versioning 2.0.0. Entries are written
> in Chinese (the project's primary language) and describe user-visible behavior rather than individual
> commits. Dates use `YYYY-MM-DD`; `0.1.0` is the current baseline and has not been published to npm yet.

本文件记录本项目的所有重要变更。格式基于 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。日期为 `YYYY-MM-DD`。

变更按用户可感知的行为归纳，不逐条对应 commit；同一版本内按「新增 / 变更 / 修复 / 安全」分组，空分组不列出。

## [Unreleased]

### 变更

- **远端运行时收敛为 npx 固定版本（npx-only）**：远端 DSH 一律用
  `npx -y @deepseek-ai/dsh@<本机 DSH 版本> --profile <profile> --no-open --port 0` 启动，`DSH_HOME` 使用远端用户真实的
  `~/.dsh`——凭据、会话、工作区就是该用户自己的那一份。删除 T0/T0-local/T1/T2/T3 自举分级、Node 下载与隔离安装：
  远端只要 Linux + Node ≥ 24.9 + npm/npx，且首次运行能访问 npm registry 即可；缺环境时明确失败并给出准备步骤，
  不自动安装 Node/npm。连接前先在前台跑一次 `npx … --version` 预检（冷缓存下载发生在预检里，失败带日志），
  回读版本必须与本机一致，否则直接 `version-mismatch`。

- **手工启动的远端 DSH 冲突提示**：插件只收养自己启动的实例；未收养时扫描远端同一 `~/.dsh` 下其他 DSH 进程
  （忽略本插件 registry pid）。命中则暂停连接（`conflict-pending`）、列出进程，由用户选择「停止它并启动受管实例」
  「保留它，另起一个（共享 ~/.dsh，给出警告）」或「取消连接」；120s 未选择按取消处理。取消/停止失败的错误码是
  `remote-dsh-running`。新增 `POST /hosts/:id/conflict`。

- **设置与契约随运行时收敛**：`settings.bootstrap` 只剩 `{ remoteDir, profile }`——`remoteDir`（默认
  `~/.dsh-remote-go`）现在只是插件状态目录（`logs/`、`run/`、租约与流助手），`profile`（默认 `web`，拒绝 `desktop`）
  决定远端 DSH 用哪个 profile；删除 `bootstrap.targetVersion` / `bootstrap.mode` / `bootstrap.nodeVersion`，主机条目也不再保存
  自己的 `bootstrap` 字段（运行时配置是全局设置）。
  `POST /hosts/:id/connect` 不再接受 `overrideVersion`；`HostView.targetVersion` 恒等于本机版本；`RemoteView` 增加
  `profile`，`bootstrapLevel` 恒为 `npx`；API 契约升到 **1.2**。

- **不再迁移旧版隔离运行时**：`~/.dsh-remote-go/{node,dsh-home,home}` 不再被读取；run 注册表还要求 `dshHome`
  （`~/.dsh`）与 `profile` 匹配才会被收养，旧进程不会被复用。

- **文档与市场描述同步**：README、`docs/`（implementation / design / api / publish / session-design）、本文件与
  `market/` 条目改为 npx-only 运行时，删除自举分级表与「无 Node 下载运行时 / 离线包」等已不存在的路径。

- **呈现方式收敛为「整窗接管」**：远端 DSH 由桌面端以 Chromium guest 铺满标题栏以下的整个窗口，不再有任何内嵌、
  浮层或独立窗口形态。本地侧边栏在接管期间让位，因此窗口里不会再出现「本地侧栏 + 远端侧栏」并排的两条栏。
  随之删除：`windowMode` 设置项（已存值加载时忽略）、iframe 视口与视窗工具条组件
  （`RemoteViewport` / `ViewportToolbar`）、iframe 沙箱与 `blocked-iframe` 错误视图（改为 `blocked-url`）、
  `window.open`「在新窗口打开」逃生通道、右上角浮层胶囊（含刷新/退出/主机切换菜单），以及只服务于它们的 i18n 文案。

- **接管期间注入一条 远端侧边栏注入的主机条**：注入到远端侧边栏顶部（品牌行下面），用与本地/远端一致的主题色、字体与 1.7px 图标笔画——当前主机
  全名（可下拉切换，每项带状态点）、远端页面自己的标题（即当前远端会话名）、「刷新远端界面」与「离开远端」。侧边栏只剩
  一个「远程主机」入口，点开是主机管理页（清单 / 添加 / 编辑 / 诊断 / 删除 / 打开 / 断开），点「打开」才把窗口交给远端；
  离开后回到主机管理页，远端任务不停。规则由组件生命周期实现（面板卸载即关闭承载），不靠全局点击监听去猜意图。

- **设置里的无效配置项删除**：删除固定的「窗口 / 关闭视窗行为」只读区（没有可选值），以及「镜像会话 /
  把远端镜像会话显示在本地侧边栏」开关（整窗接管后本地侧边栏不再呈现远端会话；后端镜像描述符与历史回放 API
  仍保留）。

- **面板内的「工作区」栏整体移除**：`WorkspaceRail` 组件、它的取数 hook、整套 `.drg-rail*` 样式与 20 余条相关文案都删了，
  面板只保留主机管理页。侧边栏镜像工作区（`mirrorToSidebar`）仍由 Host 侧维护。

- **移除「接管整个窗口」与「面板内嵌」两种旧形态的中间状态页**：连接时不再出现"正在接管远端窗口…"卡片；载入失败改为窗口里
  一行普通提示。相关浏览器验收（`test/e2e/plugin.e2e.js`、`.github/workflows/e2e.yml`、`web/desktop` e2e 里的面板断言）一并删除，
  单测改为断言客户端**不渲染 iframe、不调用 `window.open`、面板不含工作区栏**。

- **SSH 认证只剩「私钥文件」与「密码」**：SSH Agent 通道整体移除（不再读 `SSH_AUTH_SOCK` / Windows OpenSSH 管道，
  也不再提供 `agent` 候选项）；默认认证方式改为 `key`，旧的 `agent` 在加载时迁移为 `key`。新增 `defaultKeyPath`
  （默认 `~/.ssh/id_ed25519`）：新主机预填，未显式指定时按 `id_ed25519 → id_rsa → id_ecdsa` 回退；密钥路径一律按**用户主目录**
  展开（此前 `home` 没传给 SSH 层，`~/.ssh/...` 会展开失败，已修复）。

- **密码可以记住**：勾选后写入 DSH 的**凭据存储**（插件自有记录空间 `dsh-remote-go:ssh-password:<hostId>`），重连自动复用，
  `hosts.json` 里永远没有密码。该存储在本机是「仅当前用户可读的明文 YAML」，不是加密库——README 与界面都如实标注；
  没有凭据服务时明确说「无法保存，只能本次使用」，不假装保存。

- **文档收敛**：删除已失效的 V0 可行性报告（同站 loopback iframe，相关呈现方式已移除）与两份早期同类项目调研报告；
  结论仍保留在 README 的验收证据 / 功能表与 `docs/design.md` §11 / §15，原始材料可从 git 历史取回。`e2e/remote/README.md`
  同步改写为当前的运行时准备与运维步骤，不再复述 V0 验证。

- **删除对已移除套件的说明**：`test/e2e/plugin.e2e.js` 与 `.github/workflows/e2e.yml` 已不存在，README / CONTRIBUTING /
  `docs/publish.md` 里按它们描述的 `test:e2e` 组成、`E2E_SSH_ADDRESS` 必填要求与 `E2E_SSH_*` 一次性配置一并删除；
  `docs/implementation.md` 的客户端注册描述同步修正为当前的 `sidebar.panellist`（order 20）与主机管理页。

- **文档纠错（与代码对齐）**：删掉文档里已不存在的界面描述——面板内工作区栏与只读徽标、视窗工具条、接管状态面、
  独立错误页、「记住最近窗口」设置、导出/清理本地数据；产品摘要、设计原则与内容清单改回当前形态（桌面端
  Chromium guest 整窗接管、底部注入主机条，DSH 面板只承载主机管理）。流程描述也按实现改正：远端界面由连接
  管线自动拉起（没有单独的「启动它」按钮）、同一时刻只呈现一台远端（没有并行视窗与最近视窗）、空闲停止范围
  1–1440 分钟、服务托管是 `setsid`+`nohup` 而非 systemd。测试与覆盖率数字按当前实测更新（单元 373、集成 42、
  覆盖率 90.56 / 78.12 / 89.35），并删除已无对应产物的「真实 SSH 端到端」证据行与「真实主机手动工作流」说明。
  插件市场描述（`locale/zh`、`locale/en` 与生成的 `market/` 条目）同步改为当前形态。

### 新增

- **私钥文件浏览器**：`GET /keyfile/list` + 客户端「选择文件…」弹窗（目录可进入、文件可选中）。DSH 只提供目录选择器、
  没有选文件能力，因此由 Host 自己列目录：只读、限制在用户主目录内，`..` 与符号链接逃逸都拒绝。

- **侧边栏「远程主机」入口**（`sidebar.panellist`，order 20）：与 插件 / 自动化任务 同级的一行，图标为远端节点图形。

### 修复

- **侧边栏「远程主机」总是先落在主机管理页**：面板挂载时不再自动接管「上次使用 / 唯一」的主机（V1.0 遗留的 bootstrap
  效应）。此前点开侧边栏这一行，远端界面会立刻盖住主机管理页，主机清单 / 添加 / 编辑 / 诊断 / 删除都无处可看，也无法
  从这一行回到管理页；现在与 README、`docs/design.md` §4.3 一致：只有点主机上的「打开」才把窗口交给远端。

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
