# dsh-remote-go

在本地 DeepSeek Harness（DSH）里，用一条 SSH 打开服务器上的 DSH（类似 VS Code Remote-SSH）。侧边栏顶部的主机条在「本地」和各台远端之间切换，连上后远端界面整窗接管；远端运行时由插件自己准备的 Node + `npx` 拉起，版本与本机一致，数据留在远端用户自己的 `~/.dsh`。

**English** — Open a remote DSH from your local DSH over SSH: one host switcher, the remote UI in the whole window, a plugin-managed Node + npx runtime pinned to the local version, and data kept in the remote `~/.dsh`.

[![CI](https://github.com/Solaris136/dsh-remote-go/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Solaris136/dsh-remote-go/actions/workflows/ci.yml) [![CodeQL](https://github.com/Solaris136/dsh-remote-go/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Solaris136/dsh-remote-go/actions/workflows/codeql.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](#远端要求) [![DSH](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.3-blueviolet.svg)](#远端要求)

## 它做什么

- **主机条**：本地页面和远端页面的侧边栏顶部各有一条。本地那条列出「本地」和所有远端主机，绿点表示已连接；远端页面那条只列出「本地」和当前主机。主机管理只有这一个入口（添加、编辑、诊断、重连、重启 / 关闭、删除），设置面板里不再重复一份。
- **整窗接管，切走不重载**：远端 DSH 的原版界面占满当前窗口——桌面端用 Chromium guest 铺满窗口，本地侧边栏让位；浏览器端（`dsh web`）用同源 iframe，由本机一条只转发已连接主机隧道的反向代理提供页面。每台主机的窗口保持热态，切回来不重新加载，断开或删除才释放。本地只负责连接与承载，不复制远端的会话、工作区或凭据。
- **连接过程可见**：首次连接在浮窗里完成：确认主机指纹、按需输入密码，下方按阶段打印 SSH → 探测 → 准备运行时 → 启动 → 隧道 → 校验的日志并自动跟随；失败时的错误与建议也留在这个窗口里。连上后窗口自动关闭并接管整窗。
- **远端运行时自管**：远端不需要预装 Node，也不用安装本插件。插件把 Node 装到 `~/.dsh/remote-go/node`，再用 `npx` 拉起 `@deepseek-ai/dsh@<本机版本>`（`--port 0`），所以两端版本恒等，不动系统 Node、不需要 root，也不干扰远端其他项目。
- **重启 / 关闭远端 DSH**：已连接的主机卡片上可以直接重启或关闭远端 DSH。重启复用当前 SSH 会话，不重新认证，换新端口与新 token；关闭先弹一句确认，然后停掉本连接管理的远端进程并断开（不自动重连，点「重连」得到全新实例）。「重启」和「重连」都会浮出这台主机的连接窗口，进度与连接日志都在那里。远端自己重启（例如在远端更新插件）时，探活确认后会自动重新接管。
- **弱网也能自己缓过来**：SSH keepalive 容忍约 60 秒的停顿；探活要连续三次失败才判定远端不可用；自动重连在快速退避预算用尽后继续每约 30 秒试一次、最长 10 分钟，连接窗口会显示「链路仍未恢复，N 秒后继续重试」；远端自重启的重挂若因网络问题失败，也会自动重拨，不用手动点「重连」。
- **远端文件下载**：远端 Files 面板右键文件「下载」、右键文件夹「下载到本地」，Host 用同一条 SSH/SFTP 连接流式写入本地目录；不打包 ZIP、不限大小或数量，重名自动加 ` (2)`，保存位置限本机用户主目录。
- **给本地 AI 会话用主机**：注册三个模型工具——只读的 `remote_hosts_list`（清单、连接状态、SSH 用户与端口）、`remote_host_report`（单台主机的十项体检 + 连接日志）、`remote_exec`（在已连接主机上跑一条命令，复用插件已有的 SSH 会话）。三个工具默认全部隐藏，只注入解锁入口 `remote_tools`；调用后按会话解锁并在下一步可用。返回值不含密码、token、指纹原文或私钥路径，`remote_exec` 的写模式默认关闭，需在插件配置里显式打开。

## 安装

```bash
dsh plugin --profile web add dsh-remote-go
```

也可以在 **Settings → Plugins** 里从插件市场安装（已收录）；装完刷新页面，侧边栏顶部出现主机条。

## 上手

1. 点主机条 →「添加主机」，填 SSH 地址或 `~/.ssh/config` 别名；选私钥（默认 `~/.ssh/id_rsa`）或密码（默认保存，之后自动复用），可选跳板机。存活策略与指纹策略在「高级选项」里。
2. 点「连接」，首次连接确认主机指纹；插件探测远端、准备 Node、用 `npx` 启动远端 DSH，进度与日志都在连接窗口里。
3. 连上后自动整窗接管。点主机条里的「本地」回去，点已连接的主机再切回来，不重新加载。
4. 「管理界面」里编辑、诊断、重连、重启 / 关闭远端 DSH、删除主机；设置里调 SSH 默认值、自动重连、探活、指纹策略、保存访问令牌、语言、日志级别和远端 `profile`。
5. 悬停已连接的主机点「断开」，只断那一台；远端是否继续运行、关掉本地窗口后是否停止，都由该主机的存活策略决定（默认保留）。

## 远端要求

| 项目 | 要求 |
|---|---|
| 远端系统 | 仅 Linux；Windows / macOS 远端暂不支持 |
| 网络 | 能访问 nodejs.org（或 npmmirror.com）与 npm registry |
| 磁盘 | 约 400 MB 可用空间 |
| 命令 | `curl` 或 `wget`（下载 Node、探活界面） |
| 运行时 | glibc ≥ 2.28；musl（如 Alpine）会明确失败 |
| 本机 | DSH ≥ 0.2.2-rc.3、Node ≥ 24 |

- 首次连接把 Node 解压到 `~/.dsh/remote-go/node`，并把 `@deepseek-ai/dsh@<本机版本>` 装进远端 npx 缓存，之后走缓存；本机版本必须已发布到 npm。
- 远端 `~/.dsh` 就是该用户自己的 DSH 主目录，插件不复制、不隔离；插件自己的文件固定在 `~/.dsh/remote-go/`（日志、run registry、托管 Node、下载暂存）。`profile` 默认 `web`，可在设置里改。

## 安全

- 远端界面只绑 `127.0.0.1`，经 SSH 隧道访问；本地不监听公网。浏览器端的同源代理只服务已连接主机的回环隧道、只接受同源请求，远端 cookie 存在 Host 的 per-host jar 里，不交给浏览器。
- SSH 密码默认保存到 DSH 凭据存储（不写 `hosts.json`，不进客户端存储），之后包括 DSH 重启后的连接都会自动复用；取消「记住密码」则只用于本次连接并清除已有记录，删除主机或改用密钥认证时也会清除。密码框本身仍按需弹出：已保存的密码由 Host 尝试，只有认证失败才会再问。主机指纹首次确认，变化会强提示。
- 本地 HTTP API 的每条请求先过 DSH 自己的准入（Host/Origin + 浏览器会话），再要求同源与自定义请求头，跨站与 DNS rebinding 请求都会被拒绝。
- 诊断导出默认脱敏（token、密码、私钥、家目录）。

## 已知限制

- 远端仅支持 Linux；Node 与 npm 包都要在线下载，没有离线包，也没有系统 Node 兜底。
- 远端界面只能整窗接管，同一时间只显示一台远端；页面经 `file://` 加载且没有桌面桥时无法呈现。
- 不修改远端 DSH 的配置、插件、凭据与会话，也不迁移旧状态目录；远端已有手工启动的 DSH 时，连接会暂停并让你选择停止它、保留它另起一个，或取消。
- 主机管理（增删改、连接、断开）仍只在界面里；模型能碰到远端的唯一入口是 `remote_exec`，它的写模式默认关闭，要在插件配置里显式打开 `exec.allowWrite` 并在每次调用传 `confirm: true`。
- 浏览器端依赖远端页面使用相对路径；第三方插件硬编码根路径资源时，可能只在桌面端完整可用。
- 刷新本地页面后需要重新点主机条接管（远端任务不受影响）；改 Host 代码要重启本地 DSH，Client 半端随页面刷新加载。

## 开发

需要 Node ≥ 24、pnpm ≥ 11。

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify   # 构建 + 规范 + 格式 + 语法 + 打包 + 覆盖率 + 单测 + 集成
```

源码是 TypeScript（`index.ts`、`src/**/*.ts`；浏览器半端是 `client/src/**`）：`pnpm build` 把它们编译/打包到
`dist/`（`dist/index.js`、`dist/client.js`、`dist/src/**/*.js`）；根目录的 `index.js` 是手写的一行 shim，
再导出 `dist/index.js`（DSH 对链接式安装直接打开 `<plugin>/index.js`），`package.json` 的 `exports` 与它一致，
所以仓库根目录不产生任何产物副本，发布也不需要根目录复制（没有 `prepack`/`postpack` 的 stage/unstage）。
`dist/` **不进版本库**。`pnpm test` / `pnpm run gate` / `pnpm run verify` 都会先自动构建，`pnpm pack` 由 `prepack`
构建并校验后再打包，所以克隆后不需要手工 `pnpm build`。

| 脚本 | 作用 |
|---|---|
| `pnpm run build` | 清理并重建 `dist/`（锁定的 tsc 编译 Host 半端 + `scripts/build-client.mjs` 生成 `dist/client.js`；`pnpm build` 之外不要手改产物） |
| `pnpm run test:unit` | 单元测试（不需要网络 / SSH） |
| `pnpm run test:integration:local` | 无外部依赖集成：模拟远端、重启、关闭远端 |
| `pnpm run test:integration:external` | 需 DSH harness / 浏览器的集成 |
| `pnpm run sim:remote` | 本机模拟远端主机自检（探针 → 隧道 → HTTP 200） |

本地调试也可以直接安装仓库目录：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-remote-go
```

PR 门禁跑 `pnpm run gate` + 两组集成 + CodeQL；发布流程见 [docs/publish.md](docs/publish.md)。

## 文档

设计 [docs/design.md](docs/design.md) · 代码地图 [docs/implementation.md](docs/implementation.md) · API 契约 [docs/api.md](docs/api.md) · 发布 [docs/publish.md](docs/publish.md) · 远端测试环境 [e2e/remote/README.md](e2e/remote/README.md) · 变更记录 [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE) © dsh-remote-go contributors
