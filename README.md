# dsh-remote-go

> 在本地 DeepSeek Harness（DSH）里，通过 SSH 使用服务器上的 DSH：接管时远端界面铺满整个窗口，本地侧边栏让位；**本地与远端的侧边栏顶部都有同一条主机条**——列出「本地」和每台远端主机，点哪个就切到哪个。本地只负责连接与状态。

[![CI](https://github.com/Solaris136/dsh-remote-go/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Solaris136/dsh-remote-go/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Solaris136/dsh-remote-go/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Solaris136/dsh-remote-go/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](#远端运行时与兼容)
[![DSH](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.3-blueviolet.svg)](#远端运行时与兼容)

**English** — `dsh-remote-go` opens a **remote** DSH from your local DSH over SSH: the desktop shell renders the remote web UI as a full-window browser guest, the browser build carries the same UI in a same-origin frame fed by a local reverse proxy, and one host switcher ("Local" + every host) sits at the top of the sidebar on both sides; no iframe on desktop, no second window. Current version **0.1.0** (unpublished).

## 文档

设计 [docs/design.md](docs/design.md)（职责边界、界面、连接生命周期、运行时与安全）· 代码地图 [docs/implementation.md](docs/implementation.md) · API 契约 [docs/api.md](docs/api.md)（v2.8）· 发布流程 [docs/publish.md](docs/publish.md) · 远端测试环境 [e2e/remote/README.md](e2e/remote/README.md) · 变更记录 [CHANGELOG.md](CHANGELOG.md)

## 它是什么

- 一个 DSH 插件，**主机入口**只有侧边栏顶部的**主机条**（设置面板不注册入口）：状态点 + 当前目标名，点开是「本地」+ 每台远端主机的列表。它用页面自己的主题变量绘制，跟随字体、hover 与弹层遮罩；侧边栏收起成窄条时自动隐藏。
- 接管后看到的是**远端 DSH 自己的完整 Web 界面**，桌面端与浏览器端都能用：桌面端用 Chromium guest 铺满整个窗口（远端页面自己让出桌面标题栏那一条，与本地同一套栅格，行高、留白与浮层位置一致）；浏览器端（`dsh web`）用一个**同源 iframe**，由本机 DSH 上一条只服务已连接主机的反向代理喂页面。本地侧边栏在接管期间隐藏，窗口里只有远端那一条侧边栏；没有第二个浏览器窗口、没有浮层胶囊或「在新窗口打开」。
- 已连接的远端前面是**绿色发光的点**；没连接的点一下浮出**连接窗口**：上半是分阶段进度（指纹确认、密码也在这里），下半是这台连接的**日志**（SSH / npx / 远端启动逐行打印，自动跟随，可往上翻）；连上就自动接管整窗，失败时错误和日志留在窗口里。已连接的主机行悬停时右侧出现「断开」，只断那一台。
- 切回已打开过的远端**不重新加载**：每台主机的远端窗口保持热态（不设数量上限），切走只是隐藏；断开或删除主机才真正释放。本地只做连接与承载：**主机清单、SSH 连接与隧道、整窗接管、连接状态与诊断**，以及用户手势触发的远端文件 SFTP 转发。
- **远端文件与文件夹下载**：在远端 Files 面板右键文件选「下载」；文件夹右键菜单会多出「下载到本地」。点击后先选一个本机保存目录，Host 用同一条 SSH/SFTP 连接**流式写入**：文件写入 `<目录>/<文件名>`，文件夹新建同名目录后逐个文件写入；同名文件或文件夹自动加 ` (2)`。不打包 ZIP、不限文件大小或数量；右下角显示可拖动的进度卡（标题栏拖动、可取消）。

## 用法（本地 ↔ 远端）

1. **进远端**：点主机条 → 选一台已连接的主机（绿点发光）→ 远端界面接管整个窗口。
2. **换远端 / 连新的**：列表里直接点另一台，没连接的会先浮出连接窗口显示进度与连接日志，连上后自动接管。点列表最下面的「添加主机」填一次 SSH 信息：点「连接」保存并立即连上去，点「保存」只把配置记下来；没有单独的「连接测试」步骤。
3. **管主机**：点「管理界面」浮出主机清单，编辑 / 诊断 / 重连 / 删除都在那里。两者都是浮窗，远端开着时背景仍是远端，关掉回到原来那一页。
4. **断开 / 回本地**：悬停已连接的主机点「断开」，只断那一台；点「本地」回到本地页面，SSH 连接与远端任务都不停，随时可以再切回去。
5. **下载远端文件或文件夹**：在远端 DSH 的 Files 面板右键文件 →「下载」，或右键文件夹 →「下载到本地」；先选择本机保存目录，Host 会流式写入文件或新建同名文件夹（重名自动加 ` (2)`），不经过 Blob 或 ZIP。

## 安装与首次连接

```bash
dsh plugin --profile web add /absolute/path/to/dsh-remote-go        # 本地目录（开发 / 自用）
pnpm pack && dsh plugin --profile web add ./dsh-remote-go-0.1.0.tgz # 按发布物验证
```

发布到 npm 后可用 `dsh plugin --profile web add dsh-remote-go`（**当前尚未发布**）；也可在 **Settings → Plugins** 里以插件包目录安装。安装后刷新页面，侧边栏顶部出现主机条。

1. 点主机条 →「添加主机」→ 向导浮在当前页面上；填 SSH 地址或 `~/.ssh/config` 别名，选私钥文件（默认已填 `~/.ssh/id_rsa`，可点「选择文件…」浏览）或一次性密码；可选跳板机。存活策略与指纹策略在底部的「高级选项」里。
2. 点「连接」：首次连接在连接窗口里确认主机指纹（可「接受并记住」），下面的日志会实时显示正在做什么。
3. 插件探测远端环境，在 `~/.dsh/remote-go/node` 准备自己用的 Node（缺失或版本不符时自动下载安装），再用 `npx` 固定本机版本启动远端 DSH（首次运行还会把 DSH 下载进 npx 缓存，进度会显示在连接进度里），等待进入「已连接」。
4. 点主机条里的那台主机：远端 DSH 接管整个窗口，本地侧边栏让位，同一个主机条出现在远端侧边栏顶部；点「本地」回来。关闭视窗只关闭本地承载，远端任务继续（按主机的存活策略）。

## 远端运行时与兼容

远端运行时只有一种形态：**插件自带的 Node + `npx` 拉起与本机完全相同版本的 DSH**。远端系统里有没有 Node、装的是哪个版本都不影响它——插件只用自己的那一份，避免和远端其他项目、nvm 或包管理器互相干扰。

| 前提 | 说明 |
|---|---|
| Linux 远端 | 只支持 Linux；Windows / macOS 远端待后续版本 |
| 能访问 nodejs.org（或 npmmirror.com）与 npm registry | 首次连接下载 Node 官方 Linux 构建（`.tar.gz`，约 50 MB），解压到 `~/.dsh/remote-go/node/v<version>`；第一次运行把 `@deepseek-ai/dsh@<本机版本>` 下载进 npx 缓存，之后走缓存 |
| 约 400 MB 可用磁盘 | tarball、解压后的 Node 与临时目录 |
| curl 或 wget | 下载 Node，以及启动后对 `127.0.0.1:<port>` 的界面探活 |

连接时实际执行的命令是固定的：

```bash
env DSH_HOME=~/.dsh PATH=~/.dsh/remote-go/node/v<version>/bin:"$PATH" \
  ~/.dsh/remote-go/node/v<version>/bin/npx -y @deepseek-ai/dsh@<本机版本> --profile <profile> --no-open --port 0
```

- **托管 Node 固定版本**：要装的版本 = 本机 DSH 自己声明的 `engines.node` 下限（当前 `>=24.9.0` → Node 24.9.0），随插件读取、不追最新补丁，
  已装同一版本就复用；下载前校验官方 `SHASUMS256.txt` 的 SHA-256 才解压，nodejs.org 不可达时回退 npmmirror.com 的同一版本。**永远不修改系统 Node、不需要 root**；没有系统 Node 兜底。
- **`~/.dsh` 是远端用户真实的 DSH 主目录**：凭据、会话、插件配置就是该用户自己的那一份，插件不复制、不隔离。插件自己的文件固定在 `~/.dsh/remote-go/`（不是设置项）：`logs/web.log`、`run/web.json`、`node/`、`downloads/`。
- **`profile` 可配**：设置项 `bootstrap.profile`（默认 `web`）；`desktop` 留给桌面端，不能选。
- **连接前先预检**：托管 Node 就绪后，用它的 `npx -y @deepseek-ai/dsh@<本机版本> --version` 在前台跑一次（冷缓存下载就发生在这里），回读版本必须与本机一致，
  否则直接 `version-mismatch` 失败。下载不到 Node（网络 / 磁盘 / 架构 / musl / glibc 过低，官方构建要求 glibc ≥ 2.28）、npx 拉不到本机版本、回读版本不一致，都会停在可解释、可重试的错误上。
- **兼容性**由 `package.json` 的 `engines.dsh`（`>=0.2.2-rc.3`：界面统一注册在 `shell.overlay` 插槽）与
  `engines.node`（`>=24`）声明。远端一律由 `npx` 按本机版本拉起，所以本机 DSH 版本必须已发布到 npm，插件与
  远端 DSH 版本恒等。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 安全

- 远端界面只绑 `127.0.0.1`，经 SSH 隧道访问；本地也不监听公网。
- 浏览器端的同源代理只服务 `connected` 主机的回环隧道，只接受同源请求；远端的 session cookie 只存在 Host 的
  per-host cookie jar 里，不交给浏览器，本地 DSH 的 cookie 也不会转发给远端。
- SSH 密码默认只用于本次连接（内存）；勾选保存后写入 DSH 凭据存储（插件自有记录空间，不进 `hosts.json`），其保护强度由 DSH 的凭据实现决定，插件不额外加密。
- 主机指纹首次确认、变化强提示；诊断导出默认脱敏（token / 密码 / 私钥 / 家目录）。
- 本地 HTTP API 要求同源 + 自定义请求头（`x-dsh-remote-go`）；同源代理使用同一 Origin / `sec-fetch-site` 栅栏。跨站请求被拒绝。
- 操作都在远端执行；首次进入提示「你正在操作远端服务器」，关闭时提示「远端任务会继续运行」。

发现安全问题请**不要**公开提交 issue，通过 [GitHub Security Advisory](https://github.com/Solaris136/dsh-remote-go/security/advisories/new) 私密报告。

## 开发与测试

前置：Node ≥ 24、pnpm ≥ 11（版本见 `packageManager` 字段）。

```bash
pnpm install --frozen-lockfile --ignore-scripts   # 不执行生命周期脚本
pnpm run verify                                   # 仓库规范 + 格式 + 语法 + workflow + 市场条目 + 打包 + 单测 + 集成
```

| 命令 | 作用 |
|---|---|
| `pnpm run test:unit` | 单元测试（Host + Client + 同源远端代理），不需要网络 / SSH |
| `pnpm run test:integration` | 模拟远端 + 隔离 `dsh web` 的同源代理端到端 + 真实浏览器载体；缺 harness 时跳过，`DSH_E2E_STRICT=1` 下改为失败 |
| `pnpm run test:coverage` | 覆盖率门禁（阈值 85 / 70 / 80，不含 `vendor/` 与 `test/`） |
| `pnpm run test:web` / `test:desktop` | 打包产物验收：隔离 `dsh web` / 真实桌面端安装 tarball、打开管理浮窗、浅/深色对比度与第三方主题 |
| `pnpm run sim:remote` | 模拟远端主机自检（探针 → 隧道 → HTTP 200） |

模拟远端主机（`e2e/sim`，不需要真实服务器）：

```bash
pnpm run sim:remote
node e2e/sim/simulated-remote.mjs --serve --state-file <file>
```

它用 ssh2 在本机起一个真实 SSH 端点（回环地址、默认凭据，可用 `--ssh-user` / `--ssh-password` 覆盖），并只允许转发到自己的端口。运行参数见 `e2e/sim/simulated-remote.mjs` 开头的用法说明。

## CI 与发布

| 工作流 | 触发 | 内容 |
|---|---|---|
| `ci.yml` | push `main` / PR / 手动 | PR 门禁：`Verify`（仓库规范 + 格式 + PR 标题 + 覆盖率 + 集成 + tarball）、`Tests`（Windows 单测 + 集成）；CodeQL 是独立必需检查（`codeql.yml`） |
| `acceptance.yml` | 夜间定时 / 手动 | 真实浏览器与桌面端验收（**非门禁**），失败上传截图与日志 |
| `release.yml` | `v*` 标签 / 手动 | 校验版本 → 跑门禁 → 打包 → 发布 npm → 创建 GitHub Release |

发布前请本地跑一遍 `pnpm run verify`；完整步骤见 [docs/publish.md](docs/publish.md)。

## 已知限制

- 不做沉浸模式、本机通知、多窗口分屏、远端设置 diff / 备份管理。
- 不写远端 `~/.dsh`：插件、配置、凭据与会话都由远端自己维护，本插件只负责连接与呈现。
- 远端仅支持 Linux，首次连接需要能访问 nodejs.org（或 npmmirror.com）与 npm registry，**没有离线包**；官方 Node 构建要求 glibc ≥ 2.28，musl（如 Alpine）会明确失败。
- 托管 Node 是唯一运行时：系统 Node 永远不参与，装不上时连接明确失败、不会降级；远端 DSH 版本恒等于本机版本（本机版本必须已发布到 npm）。
- 不迁移旧版的独立状态目录（`~/.dsh-remote-go`）：升级后插件文件固定在 `~/.dsh/remote-go`。插件只收养自己启动的远端实例；远端已有手工启动的 DSH 时连接会暂停并列出这些进程，由你选择「停止它并启动受管实例」「保留它，另起一个」或「取消连接」。
- 远端界面只能**整窗接管**：桌面端用 Chromium guest，浏览器端（`dsh web`）用同源 iframe + 本地反向代理；
  页面经 `file://` 加载且没有桌面桥时没有远端呈现方式。多台远端在同一时刻只能呈现一台。
- 浏览器端的远端文件夹下载需要页面能拿到本机目录（DSH 的目录选择器）；拿不到时在下载入口提示，不静默改写到别处。
- 浏览器端依赖远端页面使用相对路径；远端第三方插件若硬编码根路径资源，可能只在桌面端完整可用。
- 刷新本地页面后主机条会重新出现，点那台主机即可再次接管（远端任务不受影响）；修改 Host 插件代码需重启本地 DSH 生效（Client 半端随页面刷新加载）。

## License

[MIT](LICENSE) © dsh-remote-go contributors
