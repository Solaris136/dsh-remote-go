# dsh-remote-go

> 在本地 DeepSeek Harness（DSH）里，通过 SSH 使用服务器上的 DSH：接管时远端界面铺满整个窗口，本地侧边栏让位给远端自己的侧边栏，底部只留一条注入的主机条（会话状态栏那一行）。本地只负责连接、入口与状态。

[![CI](https://github.com/Solaris136/dsh-remote-go/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Solaris136/dsh-remote-go/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Solaris136/dsh-remote-go/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Solaris136/dsh-remote-go/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](#版本与兼容)
[![DSH](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.1-blueviolet.svg)](#版本与兼容)

**English** — `dsh-remote-go` is a [DeepSeek Harness](https://github.com/deepseek-ai) plugin that opens a **remote** DSH
from your local DSH over SSH. The remote DSH web UI is rendered by the desktop shell as a live browser guest over the **main content
area** while the local sidebar stays usable as the switcher — nothing is embedded in a frame and no second
browser window is opened; hosts are managed in
**Settings → Remote hosts**. The local half only does four things:
host inventory, SSH connection plus tunnel, main-content takeover, and connection status/diagnostics. Current version:
**0.1.0** (a **thin client**, not yet published to npm; no remote-side components are installed beyond vanilla DSH).

## 目录

- [它是什么](#它是什么)
- [当前状态与验收证据](#当前状态与验收证据)
- [功能](#功能)
- [安装](#安装)
- [快速开始](#快速开始)
- [远端运行时](#远端运行时)
- [架构与关键决策](#架构与关键决策)
- [安全](#安全)
- [版本与兼容](#版本与兼容)
- [开发与测试](#开发与测试)
- [CI 与发布](#ci-与发布)
- [已知限制](#已知限制)
- [参与贡献](#参与贡献)
- [License](#license)

## 文档

| 文档 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 产品与协议设计（含 V1.0 范围、远端运行时、威胁模型） |
| [docs/implementation.md](docs/implementation.md) | 模块划分与实现要点 |
| [docs/api.md](docs/api.md) | 本地 Host 插件 HTTP API 契约 |
| [docs/publish.md](docs/publish.md) | 发布到 npm / 插件市场的流程与检查清单 |
| [docs/session-design.md](docs/session-design.md) | 「完全会话」设计：远端会话镜像成本地原生会话（能力分级、数据模型、事件流、失败模式） |
| [e2e/remote/README.md](e2e/remote/README.md) | 远端测试环境的准备与复跑步骤 |

## 它是什么

- 一个 DSH 插件：主机在 **设置 → 远程主机**（或侧边栏的「远程主机」入口）里配置，点「打开」后远端 DSH 接管**整个窗口**。
- 接管后看到的是**远端 DSH 自己的完整 Web 界面**：桌面端用 Chromium guest 把它铺满窗口（标题栏以下）。本地侧边栏在接管期间隐藏，所以窗口里只有一个侧边栏——远端自己的那个。没有 iframe、不开第二个浏览器窗口。
- 接管期间，插件把**主机条注入远端页面自己的侧边栏**（品牌行下方）：状态点 + 当前主机全名（点开切换）+ 远端会话名；菜单里还有刷新与「离开远端」。它用远端页面的主题变量绘制，跟着远端的字体、hover、弹层遮罩一起变，看不出是外接的。
- 本地只做四件事：**主机清单、SSH 连接与隧道、整窗接管、连接状态与诊断**。
- 远端只需**原版 DSH 的运行前提**：Linux + Node ≥ 24.9（含 npm/npx）。插件用 `npx -y @deepseek-ai/dsh@<本机版本>` 拉起远端 DSH——**不安装、不下载 Node**，远端数据就是该用户自己的 `~/.dsh`。

## 切换方式（本地 ↔ 远端）

1. **进远端 / 换远端**：点侧边栏的「远程主机」→ 主机管理页 → 在目标主机上点「打开」。
2. **换另一台主机**：接管期间在底部主机条里选另一台；没连接的主机会先回到主机管理页显示连接进度，连上后自动重新接管。
3. **回本地**：点主机条右侧的「离开远端」回到主机管理页，再点侧边栏里的本地工作区 / 会话。远端任务不会停。

接管是整窗的，所以没有「本地侧边栏 + 远端侧边栏」并排的两条栏；也没有浮层胶囊、没有「在新窗口打开」、没有面板内的工作区栏。

## 当前状态与验收证据

**0.1.0**（尚未发布到 npm）：设计文档 v0.6 中定义的 V1.0 范围已全部实现，含单元测试与真实测试主机上的端到端验收。

| 证据 | 结果 |
|---|---|
| 单元测试（Host + Client） | `pnpm run test:unit` → **373** 用例全部通过；集成/E2E `pnpm run test:integration` → 42 用例（模拟远端 + `Web E2E` + `Desktop E2E`；后两个浏览器套件缺 harness/浏览器时跳过，`Desktop E2E` 只在 Windows 上运行） |
| 覆盖率门禁 | `pnpm run test:coverage` → 行 **90.63%** / 分支 **77.75%** / 函数 **90.11%**（排除 `vendor/` 与测试自身），阈值 85 / 70 / 80 |
| 发布路径 | `pnpm pack` → tarball 仅含运行时文件 → 安装进干净 profile → API 与 client-module 均从安装目录加载（`e2e/artifacts/publish-e2e-report.json`）；该路径现由 `Acceptance E2E` 的 Web 作业（夜间定时 + 手动）复核 |
| 持续集成 | GitHub Actions 共 **3 项必需检查**（ruleset「main protection」：`strict`、无绕过）：`Verify (ubuntu-latest)`（仓库规范 + Prettier 格式 + PR 标题 + 覆盖率门禁 + 模拟远端集成/E2E + tarball 校验）、`Tests (windows-latest, Node 24)`（单元 + 模拟远端集成/E2E）、`Analyze (javascript-typescript)`（CodeQL）；真实浏览器验收（Web/Desktop E2E）与真实主机 E2E 都不在门禁里，见「CI 与发布」 |

> 端到端测试依赖一台可通过 SSH 访问、由你自行准备的主机（见 `e2e/remote/README.md`）；仓库不包含任何真实主机地址或凭据。

真实验收截图（历史版本：远端 DSH 在旧的面板内呈现；当前版本为整窗接管 + 底部主机条）：

![历史版本：远端 DSH 曾在本地面板中整页打开](e2e/artifacts/panel-remote-dsh.png)

## 功能

| 能力 | 状态 |
|---|---|
| **设置页「远程主机」**：主机清单 / 添加 / 编辑 / 删除 / 多主机切换 | ✅ 0.1.0 |
| ~~面板左侧「工作区」栏~~ **已移除**：面板只保留主机管理页，切换交给本地侧边栏（进/出）与接管内的主机条（换主机） | 🗑 0.1.0 移除 |
| **镜像会话（L1 目录镜像）**：开启 `mirrorToSidebar` 后每台远端一个 `Remote: <主机名>` 侧边栏工作区，远端会话以本地镜像会话出现；远端已删除的会话标记 `remote-deleted`，不删除本地记录 | ✅ 0.1.0 |
| **历史回放（L2）**：经 SSH 读远端会话日志，投影进本地镜像会话；`cursor` 持久化、重复同步不重复消息、缺口按「重置游标 + 全量重拉」恢复一次 | ✅ 0.1.0 |
| **镜像设置**：`mirrorToSidebar`（默认关；整窗接管后一般不需要侧边栏镜像分组）、`mirrorHistory`（默认开）、`mirrorMaxSessions`（默认 200）、`mirrorMaxEvents`（默认 200，0 = 不限） | ✅ 0.1.0 |
| 事件流 / 输入转发 / 审批桥（L3） | ⏳ 未实现：传输尝试已移除，状态是**未验证**而非已证伪（见 `docs/session-design.md` §6.4 / §11） |
| 侧边栏**只有一个**「远程主机」入口（主机管理页；不按主机拆行、无浮层控件） | ✅ 0.1.0 |
| 接入向导 3 步（SSH 信息 → 连接测试 → 远端探测/完成） | ✅ 0.1.0 |
| SSH 别名自动发现（`~/.ssh/config`）、known_hosts 只读解析 | ✅ 0.1.0 |
| 主机指纹：首次确认 / 记录 / 变化强提示 / strict 策略 | ✅ 0.1.0 |
| 认证：**私钥文件**（默认 ~/.ssh/id_ed25519，可浏览选择）或**密码**；不再支持 SSH Agent | ✅ 0.1.0 |
| 密码保存：勾选后存进 **DSH 凭据存储**（独立于 hosts.json），连接与重连自动复用 | ✅ 0.1.0 |
| 跳板机（跳板 SSH → forwardOut → 目标 SSH） | ✅ 0.1.0 |
| **接管内的主机条**：注入远端侧边栏顶部（品牌行下方，随远端主题/遮罩）：主机全名 + 远端会话名 + 刷新 + 离开远端 | ✅ 0.1.0 |
| **整窗接管**：远端 DSH 以真正的 Chromium guest 铺满窗口（标题栏以下），本地侧边栏在接管期间让位（无 iframe、无第二个浏览器窗口；下载与权限受桌面端限制） | ✅ 0.1.0 |
| 连接状态 / 分阶段进度 / 断线自动重连 | ✅ 0.1.0 |
| 手工启动的远端 DSH 冲突提示：停止 / 并存 / 取消 | ✅ 0.1.0 |
| 诊断检查表（9 项）+ 复制脱敏诊断信息 | ✅ 0.1.0 |
| 远端运行时：`npx -y @deepseek-ai/dsh@<本机版本>`（不安装、不下载 Node；要求远端 Node ≥ 24.9 + npx） | ✅ 0.1.0 |
| 版本一致性：目标版本恒为本机 DSH 版本；`npx` 预检回读不一致直接失败，不静默混用 | ✅ 0.1.0 |
| 远端存活策略：保持运行 / 退出即停 / 空闲停止（按主机） | ✅ 0.1.0 |
| 隧道收养（本地重启后复用仍在运行的远端实例） | ✅ 0.1.0 |
| 设置（SSH 默认值/自动重连/指纹策略/保存令牌开关/远端运行时 `remoteDir` + `profile`） | ✅ 0.1.0 |
| 双语界面（中文 / English） | ✅ 0.1.0 |
| 沉浸模式 / 本机通知 / 远端设置管理 | ⏳ V1.1+ |

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 安装

### 方式 1：本地目录安装（开发 / 自用）

```bash
dsh plugin --profile web add /absolute/path/to/dsh-remote-go
```

或在 DSH 的 **Settings → Plugins** 里以插件包目录安装。安装后刷新页面，打开 **设置 → 远程主机** 即可管理服务器。

### 方式 2：npm / 插件市场（尚未发布）

```bash
dsh plugin --profile web add dsh-remote-go
```

> 该命令在包发布到 npm 之后才可用；当前**尚未发布**。现在想按发布物验证，可以本地打包后安装：
>
> ```bash
> pnpm pack                                              # 产出 dsh-remote-go-0.1.0.tgz
> dsh plugin --profile web add ./dsh-remote-go-0.1.0.tgz
> ```

发布流程见 [docs/publish.md](docs/publish.md)；索引条目由 `pnpm run market:entry` 生成，并用官方
`dsh-plugin-market-index` 校验（`pnpm run market:check`）。

## 快速开始

1. 打开 **设置 → 远程主机** →「添加第一台服务器」。
2. 填 SSH 地址或 `~/.ssh/config` 别名，选私钥文件（默认已填 `~/.ssh/id_ed25519`，可点「选择文件…」浏览）或一次性密码；可选跳板机。
3. 首次连接确认主机指纹（可「接受并记住」）。
4. 插件探测远端环境（Linux / Node ≥ 24.9 / npx），用 `npx` 固定本机版本启动远端 DSH（首次运行会下载进 npx 缓存），等待进入「已连接」。
5. 点「打开」：远端 DSH 接管整个窗口，本地侧边栏让位，底部出现注入的主机条（更多的主机就在里面切换）。回到本地：点主机条右侧的「离开远端」回到主机管理页，再点侧边栏里的本地工作区 / 会话。
6. 关闭视窗只关闭本地承载，远端任务继续（按主机的存活策略）。

### 远端运行时

远端运行时只有一种形态：**用 `npx` 拉起与本机完全相同版本的 DSH**。没有自举分级、不下载 Node、不做隔离安装。

| 前提 | 说明 |
|---|---|
| Linux 远端 | 只支持 Linux；Windows / macOS 远端待后续版本 |
| Node ≥ 24.9.0 | 远端 `node` 在 PATH 上（DSH 的 `engines.node` 要求） |
| npm / npx | 随 Node 提供；`npx` 不在 PATH 上时明确失败，并提示安装 npm 或补齐 PATH |
| curl | 连接后的远端界面探活会用到（`127.0.0.1:<port>` 的 HTTP 探测） |
| 首次可访问 npm registry | 第一次运行会把 `@deepseek-ai/dsh@<本机版本>` 下载进 npx 缓存，之后走缓存 |

连接时实际执行的命令是固定的（`remoteDir` 只决定插件自己的文件写到哪里）：

```bash
env DSH_HOME=~/.dsh PATH=<node bin>:"$PATH" \
  npx -y @deepseek-ai/dsh@<本机版本> --profile <profile> --no-open --port 0
```

- **`~/.dsh` 是远端用户真实的 DSH 主目录**：凭据、会话、工作区、插件配置就是该用户自己的那一份，插件不复制、不隔离。
- **`profile` 可配**：设置项 `bootstrap.profile`（默认 `web`），profile 的插件构成在 `~/.dsh/profiles/<profile>`；会话、凭据、工作区等数据在 `~/.dsh` 下全局共享。`desktop` 留给桌面端，不能选。
- **插件只用自己的状态目录**：设置项 `bootstrap.remoteDir`（默认 `~/.dsh-remote-go/`），只放 `logs/web.log`、`run/web.json`（pid / port / version / profile / dshHome）以及租约与流助手文件；没有 `node/`、`dsh-home/`、`home/` 这类隔离产物。
- **连接前先预检**：`npx -y @deepseek-ai/dsh@<本机版本> --version` 在前台跑一次（冷缓存下载就发生在这里，失败会带日志报错），回读版本必须与本机一致，否则直接 `version-mismatch` 失败。
- **失败即明确失败**：缺 Node、Node < 24.9、缺 npx、registry 不可达或 npx 报出别的版本，都会停在可解释、可重试的错误上；不自动安装 Node/npm，也不会退化成隔离安装。
- **不迁移旧版运行时**：旧版的 `~/.dsh-remote-go/{node,dsh-home,home}` 不再被读取，旧进程也不会被收养（run 注册表还要匹配 `dshHome` 与 `profile`）。
- **本机版本必须已发布到 npm**：`npx` 要能解析到该精确版本，否则预检阶段就会失败。

所有远端文件都在用户目录，无需 root；远端界面只绑定回环地址，经 SSH 隧道访问。

## 架构与关键决策

```text
本地 DSH（Host 插件 src/ + Client 插件 client.js）
├─ 主机管理页：主机清单 / 向导 / 诊断 / 插件设置（侧边栏一行「远程主机」进入）
├─ SSH（ssh2）：认证、主机指纹、exec、forwardOut
├─ 远端运行时准备（npx 预检）/ 远端 dsh web 生命周期（start/stop/adopt）
└─ 本地回环 TCP 隧道  127.0.0.1:<localPort> ──SSH──▶ 远端 127.0.0.1:<remotePort>
                                                      │
远端服务器：原版 DSH（`DSH_HOME=~/.dsh npx -y @deepseek-ai/dsh@<本机版本> --profile web --no-open --port 0`）
└─ 远端 DSH Web 界面 ──Chromium guest（桌面端整窗接管）──▶ 本地窗口
                     └─ 整窗接管：Chromium guest 铺满窗口；内容区底部注入 远端侧边栏注入的主机条（当前主机 / 远端会话名 / 刷新 / 离开）

本地 DSH 左侧边栏（原生能力；开启 `mirrorToSidebar` 后才注册，默认关）：
└─ 每台远端主机一个工作区（标题 `Remote: <主机名>`），远端会话以镜像会话出现在其中
```

1. **整窗接管，而不是内嵌或反代**：远端 DSH 由桌面端以真正的 Chromium guest 渲染（自有 cookie 与下载管线，行为与真实浏览器一致），不再有同站 iframe、浮层控件或状态页。接管时本地侧边栏隐藏、远端自己的侧边栏成为窗口里唯一的侧边栏；本地只留一条注入的主机条负责换主机和离开。早期同站 loopback iframe 的可行性结论已随该形态一并退役（可从 git 历史取回）。
2. **每台主机独立本地端口**：cookie 按 authority 绑定，多主机登录态天然隔离。
3. **远端运行时只用固定模板命令**（`npx -y @deepseek-ai/dsh@<本机版本>` 预检与启动），不接受任意 shell；不安装、不下载 Node。
4. **版本一致**：目标版本恒为本机 DSH 版本（`clientModules.graph().release.version` → `DSH_VERSION` → 本机 `@deepseek-ai/dsh/package.json` 兜底），预检与启动都写精确版本；npx 回读不一致直接失败，不静默混用。
5. **零运行时依赖、零安装脚本**：`ssh2` 由 `scripts/build-vendor.mjs` 打包成 `vendor/ssh2.bundle.cjs`，发布包 `dependencies: {}`，安装不执行任何 npm 生命周期脚本（供应链更可控，CI/市场安装更稳）。

更细的模块划分见 [docs/implementation.md](docs/implementation.md)。

## 安全

- 远端界面只绑 `127.0.0.1`，经 SSH 隧道访问；本地也不监听公网。
- SSH 密码默认只用于本次连接（内存）；**勾选保存后写入 DSH 凭据存储**（`<DSH_HOME>/.credentials.yaml`，插件自有记录空间，不进 `hosts.json`）。
  ⚠️ 该存储在**本机**是「仅当前用户可读的明文 YAML」，不是加密库；需要加密请换用提供加密凭据存储的组合。密钥内容不上传、不复制。访问令牌默认只在内存（可选 0600 保存）。
- 主机指纹首次确认、变化强提示；诊断导出默认脱敏（token/密码/私钥/家目录）。
- 本地 HTTP API 要求同源 + 自定义请求头；跨站请求被拒绝。
- 操作都在远端执行；首次进入提示「你正在操作远端服务器」，关闭时提示「远端任务会继续运行」。

发现安全问题请**不要**公开提交 issue，按 [SECURITY.md](SECURITY.md) 私下报告。

## 版本与兼容

| 版本 | 状态 | 说明 |
|---|---|---|
| `0.1.x` | 开发中（未发布） | 当前版本；`0.x` 阶段不承诺兼容性 |
| 已发布版本 | 暂无 | 尚未发布到 npm，也无对应 tag/release |

- 兼容性由 `package.json` 的 `engines.dsh`（`>=0.2.2-rc.1`）与 `engines.node`（`>=24`）声明，安装和运行都会校验。
- 远端要求 **Linux + Node ≥ 24.9.0 + npm/npx**，且首次连接能访问 npm registry；本机 DSH 版本需已发布到 npm（`npx` 按精确版本解析）。
- 插件与远端 DSH 的版本必须一致（见「架构与关键决策」第 4 条）；远端一律由 `npx` 按本机版本拉起，预检回读不一致会直接失败，不静默混用。
- 变更记录见 [CHANGELOG.md](CHANGELOG.md)。发布流程（npm + 插件市场）已就绪，但当前**尚未执行**；
  发布动作由 `.github/workflows/release.yml` 在 `v*` 标签上执行。

## 开发与测试

前置：Node ≥ 24、pnpm ≥ 11（版本见 `packageManager` 字段）。

```bash
pnpm install --frozen-lockfile --ignore-scripts   # 不执行生命周期脚本
pnpm run verify                                   # 一条命令跑完下面全部门禁
```

`pnpm run verify` 依次执行：

| 命令 | 作用 |
|---|---|
| `pnpm run lint` | 仓库规范检查（必需文件、元数据、版本一致性、换行/空白、密钥泄漏、workflow 约定） |
| `pnpm run format:check` | Prettier 格式检查（配置见 `.prettierrc.json`） |
| `pnpm run check:syntax` | 用 `node --check` 解析所有生产/测试/脚本 JS（当前 81 个文件） |
| `pnpm run check:workflows` | 用真实 YAML 解析器校验 `.github/workflows/*.yml`（当前 6 个工作流） |
| `pnpm run market:check` | 用官方 `dsh-plugin-market-index` 校验市场条目（当前 30 个运行时文件） |
| `pnpm run pack:check` | 校验 `files[]` 覆盖与打包内容 |
| `pnpm run test:unit` | 单元测试（373 用例，Host + Client，无需网络/SSH） |
| `pnpm run test:integration` | 集成/E2E（42 用例）：模拟远端 + `Web E2E` + `Desktop E2E`，缺 harness/浏览器时跳过 |

覆盖率门禁（`pnpm run test:coverage`，阈值 85 / 70 / 80）**不在** `verify` 里：它由 CI 的
`Repository conventions` 作业执行，本地可单独跑。

发布路径验收（把 tarball 装进干净的 `dsh` profile，不需要远端主机）：

```bash
pnpm run test:e2e   # pnpm pack → 装进隔离 profile → API 与 client-module 都从安装目录加载
```

Web 兼容性验收（`dsh web` + 真实浏览器，不需要远端主机）：

```bash
pnpm run test:web       # 打包产物 → 隔离的 dsh web 里真装一次 → Chrome 打开真实界面 → 浅色/深色按钮对比度断言
pnpm run test:desktop   # 仅 Windows：真实 Electron 桌面端（隔离 profile）→ 同样的对比度断言
```

两个用例都验收**打包产物**而不是工作区：先在仓库里 `pnpm pack`，再把 `dsh-remote-go-<version>.tgz` 装进隔离 profile，
并断言依赖形如 `file:…tgz`（不是 `link:`）且安装副本含 `client.js`/`index.js`/`cordis.patch.yml`/`locale/`/`vendor/`
等文件——这样 `files[]`/`exports` 漏文件会在 CI 暴露，而不是发版后才发现。

`test:web` 需要三样东西：可用的 DSH CLI、Chrome/Edge，以及安装插件用的 `pnpm`。CLI 按以下顺序发现：
`DSH_BIN`（可配 `DSH_EXE` 指定 Electron/Node 解释器）→ Windows 默认安装目录（可用 `DSH_INSTALL_DIR` 覆盖）→
该目录/包内的 `lib/bin.js`（其中第一个候选是 `DSH_CLI_JS`，CI 用它指向本地 npm 安装，免去全局 bin）→
PATH 上的 `dsh`。Windows 安装目录会用 `--version` 实际探测（`app.asar` 是虚拟文件系统，只看文件是否存在不可靠），
**探测失败即跳过**——注意：装在非默认目录又没有设置 `DSH_INSTALL_DIR` 时，同样只会跳过（不会报错）。
浏览器用 `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` / `E2E_CHROME` 指定（否则探测 Chrome/Edge 的常见路径），
`pnpm` 不在 PATH 时可用 `DSH_PNPM_CJS` 指向 pnpm 入口。

两个套件共用的三个开关：

| 变量 | 作用 |
|---|---|
| `DSH_E2E_STRICT=1` | 缺少 harness/浏览器/桌面端时**失败**而不是跳过（CI 必需检查就是这个模式，避免静默空跑） |
| `DSH_E2E_LANG` | 固定界面语言（默认 `en-US`）。用例对文本比较两侧都做归一化，并在 en-US / zh-CN 下都验证过 |
| `DSH_WEB_E2E_ARTIFACTS` / `DSH_DESKTOP_E2E_ARTIFACTS` | 失败时截图与日志的输出目录（两套件各用各的），CI 用它上传 artifact |

`test:desktop` 只在 Windows 有意义（桌面端没有 Linux 构建，也不在 npm 上）。它用 `DSH_DESKTOP_EXE` 指定可执行文件，
或用 `DSH_DESKTOP_INSTALL_DIR` 指定安装目录，否则在 `%LOCALAPPDATA%\Programs` 与 `%PROGRAMFILES%` 下搜索
`DeepSeek Harness.exe`。三条实现细节值得记住：

- `dsh plugin --profile desktop add …` 会被 CLI 拒绝（`profile "desktop" is managed exclusively by the Electron
  application`），所以 profile 是手工写的：`<DSH_HOME>/profiles/desktop/package.json` 里给 `dsh.profile.bundles`
  加上 `dsh-remote-go` 并声明 `file:<tgz>` 依赖，然后在该目录跑一次 `pnpm install --ignore-scripts`。
  **这一步不能省**：没有 `node_modules`，客户端半边不会加载。
- 启动时必须**去掉** `ELECTRON_RUN_AS_NODE`（否则 Electron 以 Node 模式运行，`--user-data-dir` /
  `--remote-debugging-port` 会被当成非法参数）。
- 全新 profile 会先弹 `…/renderer/welcome.html`（登录引导），用例点 **`稍后配置`** 跳过，不使用任何凭据。
- 桌面端欢迎页是独立 `file://` 页面，其语言跟随**系统语言**而非 `--lang`；用例会打印该页的
  `documentElement.lang` / `navigator.language` 与实际点击到的标签，语言不符时看日志即可定位，而不是表现为导航超时。

另外 `[data-dsh-remote-go="styles"]` 在桌面端**不存在**（样式却已生效），所以“客户端已加载”一律按行为断言
（插件 class + CSS 变量可解析），不用这个标记。

缺任何一样都**跳过而不是失败**，所以 `pnpm run verify` 与 `ci.yml` 在没有 Harness 的机器上仍然全绿；CI 里由
`acceptance.yml` 备好 harness / 桌面端后以 `DSH_E2E_STRICT=1` 运行
（缺件即失败，避免静默空跑）。`.github/workflows/acceptance.yml` 只在**夜间定时 + 手动**运行，不构成 PR 门禁
——真实 Chrome/Electron 套件对 runner 负载敏感，放在门禁里只会让偶发超时阻塞合并。门禁只保留三项必需检查：
`Verify (ubuntu-latest)`、`Tests (windows-latest, Node 24)`、`Analyze (javascript-typescript)`；
失败时仍会上传截图与日志（`web-e2e-failure` / `desktop-e2e-failure` artifact）。

### 模拟远端主机（`e2e/sim`）

镜像会话与历史回放等能力**不需要真实主机**即可验证：`e2e/sim/simulated-remote.mjs` 用 ssh2 在本机起一个真实 SSH
端点（回环地址、默认凭据（可用 `--ssh-user/--ssh-password` 覆盖）、只允许转发到自己的端口），并用一个 HTTP stub 扮演远端 DSH 的 web。

```bash
pnpm run sim:remote                                     # 自检：探针 → 隧道 → HTTP 200
node e2e/sim/simulated-remote.mjs --serve --workspace-fixture <file> --state-file <file>
```

`--serve` 常驻；`--workspace-fixture` 指定远端 `storages/workspace.json` 的内容（用于构造多工作区/多会话场景），
`--state-file` 指定状态文件（`node --test` 并行跑多个用例时需要各用各的）。隔离护栏：只绑回环、拒绝非回环配置退出、
凭据必须匹配、转发目标限定自身端口。

目录：

```text
index.js / client.js        Host / Client 入口（包根）
src/                        Host 插件实现（SSH/运行时/隧道/服务/API/诊断）
locale/                     插件市场显示元数据（zh/en）
cordis.patch.yml            插件 bundle patch
test/unit/                  单元测试（node:test）
test/e2e/                   发布路径验收（tarball → 干净 profile）
e2e/control/                隔离的 control DSH 运行时/启动脚本
e2e/remote/                 测试主机准备与运维脚本
scripts/                    规范检查 / 市场条目 / 打包校验脚本
docs/                       设计、实现、API、发布文档
```

E2E 环境变量：`E2E_NODE`（Node 可执行文件，默认取 PATH 中的 `node`）、`E2E_CHROME`（浏览器可执行文件路径）。仓库内的套件已经不再连真实主机，因此不读 `E2E_SSH_ADDRESS`；手动做真实主机验收时按 `e2e/remote/README.md` 起远端运行时即可。

## CI 与发布

| 工作流 | 触发 | 内容 |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | push `main` / PR / 手动 | **PR 门禁**：`Verify (ubuntu-latest)`（仓库规范 + Prettier 格式 + PR 标题 + 覆盖率门禁 + 模拟远端集成/E2E + `pnpm pack`/tarball 校验并上传 artifact）、`Tests (windows-latest, Node 24)`（单元测试 + 模拟远端集成/E2E） |
| [`codeql.yml`](.github/workflows/codeql.yml) | push/PR `main` / 每周 | CodeQL 静态分析（`security-and-quality`） |
| [`release.yml`](.github/workflows/release.yml) | `v*` 标签 / 手动 | 校验标签与版本一致 → 跑门禁 → 打包 → 发布 npm（有 token 时，含 provenance）→ 创建 GitHub Release |
| [`acceptance.yml`](.github/workflows/acceptance.yml) | 夜间定时 / 手动 | 真实浏览器验收（**非门禁**）：Web 兼容性（安装 `@deepseek-ai/dsh` + Chrome → 打包产物真装进隔离 `dsh web` → 设置页浅色/深色按钮对比度断言）与桌面端兼容性（静默安装官方 Electron 桌面端 → 手工构建 desktop profile 装打包产物 → CDP 驱动真实窗口 → 同样的对比度断言）；失败上传截图与日志 |

发布前请本地跑一遍 `pnpm run verify`；`prepack` 还会自动执行 `market-entry --check`，防止带病发布。完整发布步骤见
[docs/publish.md](docs/publish.md)。

## 已知限制

- 不做沉浸模式（`shell.overlay`）、本机通知、多窗口分屏、远端设置 diff/备份管理。
- 远端仅支持 Linux；Windows 远端待后续版本。
- 远端需要自备 Node ≥ 24.9 与 npm/npx，并且首次连接能访问 npm registry；插件不会自动安装 Node/npm，也没有离线包。
- 远端 DSH 版本恒等于本机版本：本机版本必须已发布到 npm，否则 `npx` 解析不到、连接在预检阶段失败。
- 不迁移旧版的隔离运行时（`~/.dsh-remote-go/{node,dsh-home,home}`）：升级后远端数据改为用户自己的 `~/.dsh`，旧目录不再使用。
- 插件只收养自己启动的远端实例（run 注册表匹配 `dshHome` + `profile`）；远端如果已有手工启动的 DSH，连接会暂停并列出这些进程，由你选择「停止它并启动受管实例」「保留它，另起一个」或「取消连接」。
- 远端界面只能**整窗接管**：非桌面端（例如浏览器里的 `dsh web`）没有 guest 能力，此时没有可用的远端呈现方式（也没有内嵌或独立窗口的退路）。
- 多台远端在同一时刻只能呈现一台：在主机管理页点另一台的「打开」即切换。
- 刷新本地页面需要重新打开视窗（远端任务不受影响）。
- 修改 Host 插件代码需重启本地 DSH 生效（Client 半端随页面刷新加载）。
- **镜像会话只到 L2（回放，不流式）**：`stream` / `input` / `approve` 三个能力仍为 `false`，实时性没有承诺。
  事件流（L3）曾在别的传输上尝试过，在**修复两个真实缺陷之后没有重新验证**就为收敛范围移除——所以它是
  「未验证」，不是「已证明不可用」（`docs/session-design.md` §6.4 / §11）。
- **写入租约的远端校验目前只由模拟远端实现**（`e2e/sim`）：未改造的真实 DSH 没有这段校验，因此
  「两个客户端只有一个能写」只在模拟远端下成立（`docs/session-design.md` §11）。

## 参与贡献

- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)（开发环境、提交规范、PR 流程）
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 安全问题：[SECURITY.md](SECURITY.md)（请勿公开提交 issue）
- 变更记录：[CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE) © dsh-remote-go contributors
