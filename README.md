# dsh-remote-go

> 在本地 DeepSeek Harness（DSH）里，通过 SSH 使用服务器上的 DSH：接管时远端界面铺满整个窗口，本地侧边栏让位；**本地与远端的侧边栏顶部都有同一条主机条**——列出「本地」和每台远端主机，点哪个就切到哪个。本地只负责连接与状态。

[![CI](https://github.com/Solaris136/dsh-remote-go/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Solaris136/dsh-remote-go/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Solaris136/dsh-remote-go/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Solaris136/dsh-remote-go/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](#版本与兼容)
[![DSH](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.1-blueviolet.svg)](#版本与兼容)

**English** — `dsh-remote-go` is a [DeepSeek Harness](https://github.com/deepseek-ai) plugin that opens a **remote** DSH from your local DSH over SSH. The desktop shell renders the remote DSH web UI as a live browser guest filling the whole window, and the plugin draws one host switcher at the top of the sidebar — in the local page and in the remote one — that lists "Local" plus every host. Nothing is embedded in a frame and no second browser window is opened; hosts are managed in **Settings → Remote hosts**. Current version: **0.1.0** (unpublished).

## 文档

| 文档 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 产品设计：职责边界、界面、连接生命周期、运行时与安全 |
| [docs/implementation.md](docs/implementation.md) | 代码地图：模块、连接管线、持久化、测试与结构守卫 |
| [docs/api.md](docs/api.md) | 本地 Host ↔ Client HTTP API 契约（v2） |
| [docs/publish.md](docs/publish.md) | 发布到 npm / 插件市场的流程与检查清单 |
| [e2e/remote/README.md](e2e/remote/README.md) | 真实测试主机的准备与复跑步骤 |

## 它是什么

- 一个 DSH 插件：主机在 **设置 → 远程主机** 里增删改诊断；侧边栏顶部的**主机条**就是切换器，点一台就接管整个窗口。
- 接管后看到的是**远端 DSH 自己的完整 Web 界面**：桌面端用 Chromium guest 把它铺满窗口（标题栏以下）。本地侧边栏在接管期间隐藏，窗口里只有一个侧边栏——远端自己的那个。没有 iframe、不开第二个浏览器窗口。
- 主机条在**本地和远端两侧都在**（品牌行下面），就是同一个东西：状态点 + 当前目标名（点开是列表）。列表依次是「本地」和每台远端主机：**已连接的远端前面是绿色发光的点**，表示现在可以切过去；没连接的点它是灰色，点一下浮出主机清单并开始连接（进度、指纹确认、密码都在那里）。已连接的主机行右侧还有一个「断开」——鼠标移到该行才显示，点了就断开那一台，不会顺带切过去。列表最下面是「添加主机」和「管理界面」——两者都是**浮窗**：向导浮在当前页面上，管理清单也浮在当前页面上，**远端开着的时候背景还是远端**，关掉就回到原来那一页。点「本地」才回到本地页面，点某个 IP 就切到那台远端。它用页面自己的主题变量绘制，跟随字体、hover 与弹层遮罩；侧边栏收起成窄条时它自动隐藏。
- **切回已经打开过的远端不重新加载**：每台主机的远端窗口保持热态（**不设数量上限**），切走只是隐藏，所以「本地 ↔ 远端」「远端 A ↔ 远端 B」都是瞬时的；断开或删除主机时才真正释放。
- 本地只做四件事：**主机清单、SSH 连接与隧道、整窗接管、连接状态与诊断**。
- 远端只需 **Linux + 能访问 nodejs.org（或 npmmirror.com）与 npm registry**：插件把**自己的 Node** 固定安装到 `~/.dsh/remote-go/node`（版本取本机 DSH `engines.node` 的下限，官方 tarball + SHA-256 校验，不碰系统 Node、不需要 root），再用 `npx -y @deepseek-ai/dsh@<本机版本>` 拉起远端 DSH；远端数据就是该用户自己的 `~/.dsh`。

## 切换方式（本地 ↔ 远端）

只有一处入口：侧边栏顶部的主机条，点开是一份列表（其余界面都是它拉起的浮窗或整个窗口）。

1. **进远端**：点主机条 → 选一台已连接的主机（绿点发光）→ 远端界面接管整个窗口。
2. **换远端**：在列表里直接点另一台；没连接的主机会先浮出主机清单显示进度，连上后自动接管。回到已打开过的主机是瞬时的（窗口保持热态，不重新加载）。
3. **连一台新的**：点列表最下面的「添加主机」，向导浮在当前页面上，填 SSH 信息、测试连接即可。
4. **管主机**：点「管理界面」浮出主机清单，编辑 / 诊断 / 重连 / 删除都在那里（也可以从 设置 → 远程主机 进入）。远端开着时它浮在远端上面，关掉仍在远端。
5. **断开某台**：在列表里把鼠标移到那台已连接的主机上，右侧会出现「断开」；点了就断开它的 SSH 并关掉它的窗口。
6. **回本地**：在列表里点「本地」。SSH 连接与远端任务都不会停，随时可以再切回去。

接管是整窗的，所以窗口里只有一条侧边栏；也没有浮层胶囊、没有「在新窗口打开」、没有面板内的工作区栏。

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

> 该命令在包发布到 npm 之后才可用；当前**尚未发布**。按发布物验证可以先本地打包：

```bash
pnpm pack                                              # 产出 dsh-remote-go-0.1.0.tgz
dsh plugin --profile web add ./dsh-remote-go-0.1.0.tgz
```

发布流程见 [docs/publish.md](docs/publish.md)。

## 快速开始

1. 点侧边栏顶部的**主机条**→「添加主机」→ 向导浮在当前页面上（也可以从 **设置 → 远程主机** →「添加第一台服务器」进入）。
2. 填 SSH 地址或 `~/.ssh/config` 别名，选私钥文件（默认已填 `~/.ssh/id_ed25519`，可点「选择文件…」浏览）或一次性密码；可选跳板机。
3. 首次连接确认主机指纹（可「接受并记住」）。
4. 插件探测远端环境，在 `~/.dsh/remote-go/node` 准备自己用的 Node（缺失或版本不符时自动下载安装），用 `npx` 固定本机版本启动远端 DSH（首次运行还会把 DSH 下载进 npx 缓存，进度会显示在连接进度里），等待进入「已连接」。
5. 点主机条里的那台主机：远端 DSH 接管整个窗口，本地侧边栏让位，同一个主机条出现在远端侧边栏顶部。回到本地：在主机条里点「本地」。
6. 关闭视窗只关闭本地承载，远端任务继续（按主机的存活策略）。

### 远端运行时

远端运行时只有一种形态：**插件自带的 Node + `npx` 拉起与本机完全相同版本的 DSH**。远端系统里有没有 Node、装的是哪个版本都不影响它——插件只用自己的那一份，避免和远端其他项目、nvm 或包管理器互相干扰。

| 前提 | 说明 |
|---|---|
| Linux 远端 | 只支持 Linux；Windows / macOS 远端待后续版本 |
| 能访问 nodejs.org（或 npmmirror.com） | 首次连接下载 Node 官方 Linux 构建（`.tar.gz`，约 50 MB），解压到 `~/.dsh/remote-go/node/v<version>`；之后复用 |
| 首次可访问 npm registry | 第一次运行会把 `@deepseek-ai/dsh@<本机版本>` 下载进 npx 缓存，之后走缓存 |
| 约 400 MB 可用磁盘 | tarball、解压后的 Node 与临时目录 |
| curl | 连接后的远端界面探活会用到（`127.0.0.1:<port>` 的 HTTP 探测） |

连接时实际执行的命令是固定的：

```bash
env DSH_HOME=~/.dsh PATH=~/.dsh/remote-go/node/v<version>/bin:"$PATH" \
  ~/.dsh/remote-go/node/v<version>/bin/npx -y @deepseek-ai/dsh@<本机版本> --profile <profile> --no-open --port 0
```

- **托管 Node 固定版本**：要装的版本 = 本机 DSH 自己声明的 `engines.node` 下限（当前 `>=24.9.0` → Node 24.9.0），随插件读取、不追最新补丁；已装同一版本就复用。下载前校验官方 `SHASUMS256.txt` 的 SHA-256 才解压；nodejs.org 不可达时回退到 npmmirror.com 的同一版本。**永远不修改系统 Node、不需要 root**。
- **`~/.dsh` 是远端用户真实的 DSH 主目录**：凭据、会话、插件配置就是该用户自己的那一份，插件不复制、不隔离。
- **`profile` 可配**：设置项 `bootstrap.profile`（默认 `web`）；`desktop` 留给桌面端，不能选。
- **插件自己的文件固定在 `~/.dsh/remote-go/`**（不是设置项）：`logs/web.log`、`run/web.json`、`node/`、`downloads/`。
- **连接前先预检**：托管 Node 就绪后，用它的 `npx -y @deepseek-ai/dsh@<本机版本> --version` 在前台跑一次（冷缓存下载就发生在这里），回读版本必须与本机一致，否则直接 `version-mismatch` 失败。
- **失败即明确失败**：下载不到 Node（网络/磁盘/架构/musl/glibc 过低）、npx 拉不到本机版本、回读版本不一致，都会停在可解释、可重试的错误上。**没有系统 Node 兜底**。

所有远端文件都在用户目录，无需 root；远端界面只绑定回环地址，经 SSH 隧道访问。

## 安全

- 远端界面只绑 `127.0.0.1`，经 SSH 隧道访问；本地也不监听公网。
- SSH 密码默认只用于本次连接（内存）；**勾选保存后写入 DSH 凭据存储**（插件自有记录空间，不进 `hosts.json`）。该存储在**本机**是「仅当前用户可读的明文 YAML」，不是加密库；需要加密请换用提供加密凭据存储的组合。
- 主机指纹首次确认、变化强提示；诊断导出默认脱敏（token/密码/私钥/家目录）。
- 本地 HTTP API 要求同源 + 自定义请求头；跨站请求被拒绝。
- 操作都在远端执行；首次进入提示「你正在操作远端服务器」，关闭时提示「远端任务会继续运行」。

发现安全问题请**不要**公开提交 issue，按 [SECURITY.md](SECURITY.md) 私下报告。

## 版本与兼容

- 兼容性由 `package.json` 的 `engines.dsh`（`>=0.2.2-rc.3`：界面统一注册在 `shell.overlay` 插槽）与 `engines.node`（`>=24`）声明。
- 远端要求 **Linux + 能访问 nodejs.org（或 npmmirror.com）+ 首次能访问 npm registry**；**不要求预装 Node**——插件会把自己的 Node 装到 `~/.dsh/remote-go/node` 并只使用它。本机 DSH 版本需已发布到 npm（`npx` 按精确版本解析）。
- 插件与远端 DSH 的版本必须一致：远端一律由 `npx` 按本机版本拉起，预检回读不一致会直接失败。
- 变更记录见 [CHANGELOG.md](CHANGELOG.md)。发布流程见 [docs/publish.md](docs/publish.md)。

## 开发与测试

前置：Node ≥ 24、pnpm ≥ 11（版本见 `packageManager` 字段）。

```bash
pnpm install --frozen-lockfile --ignore-scripts   # 不执行生命周期脚本
pnpm run verify                                   # 仓库规范 + 格式 + 语法 + workflow + 市场条目 + 打包 + 单测 + 集成
```

| 命令 | 作用 |
|---|---|
| `pnpm run test:unit` | 单元测试（Host + Client），不需要网络/SSH |
| `pnpm run test:integration` | 模拟远端集成；浏览器/桌面套件缺 harness 时跳过 |
| `pnpm run test:coverage` | 覆盖率门禁（阈值 85 / 70 / 80，仅统计 `src/`） |
| `pnpm run test:web` / `test:desktop` | 打包产物安装进隔离 `dsh web` / 真实桌面端后的对比度验收 |
| `pnpm run test:e2e` | tarball → 干净 profile 的发布路径验收 |
| `pnpm run sim:remote` | 模拟远端主机自检（探针 → 隧道 → HTTP 200） |

浏览器与桌面套件需要 `DSH_E2E_STRICT=1` 才会在缺件时失败（CI 的验收工作流这样运行）。环境变量与故障排查细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

模拟远端主机（`e2e/sim`，不需要真实服务器）：

```bash
pnpm run sim:remote
node e2e/sim/simulated-remote.mjs --serve --state-file <file>
```

它用 ssh2 在本机起一个真实 SSH 端点（回环地址、默认凭据，可用 `--ssh-user/--ssh-password` 覆盖），并只允许转发到自己的端口。

## CI 与发布

| 工作流 | 触发 | 内容 |
|---|---|---|
| `ci.yml` | push `main` / PR / 手动 | PR 门禁：`Verify`（仓库规范 + 格式 + PR 标题 + 覆盖率 + 集成 + tarball）、`Tests`（Windows 单测 + 集成）、CodeQL |
| `acceptance.yml` | 夜间定时 / 手动 | 真实浏览器与桌面端验收（**非门禁**），失败上传截图与日志 |
| `release.yml` | `v*` 标签 / 手动 | 校验版本 → 跑门禁 → 打包 → 发布 npm → 创建 GitHub Release |

发布前请本地跑一遍 `pnpm run verify`；完整发布步骤见 [docs/publish.md](docs/publish.md)。

## 已知限制

- 不做沉浸模式、本机通知、多窗口分屏、远端设置 diff/备份管理。
- 远端仅支持 Linux；Windows 远端待后续版本。
- 远端首次连接需要能访问 nodejs.org（或 npmmirror.com）与 npm registry；没有离线包。官方 Node 构建要求 glibc ≥ 2.28，musl（如 Alpine）会明确失败。
- 托管 Node 是唯一运行时：系统 Node 永远不参与；装不上时连接明确失败，不会降级。
- 远端 DSH 版本恒等于本机版本：本机版本必须已发布到 npm，否则 `npx` 解析不到、连接在预检阶段失败。
- 不迁移旧版的独立状态目录（`~/.dsh-remote-go`）：升级后插件文件固定在 `~/.dsh/remote-go`，旧目录不再使用。
- 插件只收养自己启动的远端实例；远端如果已有手工启动的 DSH，连接会暂停并列出这些进程，由你选择「停止它并启动受管实例」「保留它，另起一个」或「取消连接」。
- 远端界面只能**整窗接管**：非桌面端（例如浏览器里的 `dsh web`）没有 guest 能力，此时没有可用的远端呈现方式。
- 多台远端在同一时刻只能呈现一台；刷新本地页面后主机条会重新出现，点那台主机即可再次接管（远端任务不受影响）。
- 修改 Host 插件代码需重启本地 DSH 生效（Client 半端随页面刷新加载）。

## 参与贡献

- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 安全问题：[SECURITY.md](SECURITY.md)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE) © dsh-remote-go contributors
