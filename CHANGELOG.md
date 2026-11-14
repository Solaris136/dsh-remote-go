# Changelog

> **English abstract.** All notable, user-visible changes to `dsh-remote-go` are recorded here, newest first.
> The format follows Keep a Changelog 1.1.0 and versions follow Semantic Versioning 2.0.0. Entries are written
> in Chinese (the project's primary language) and describe user-visible behavior rather than individual
> commits. Dates use `YYYY-MM-DD`; `0.1.0` is the current baseline and has not been published to npm yet.

本文件记录本项目的所有重要变更。格式基于 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。日期为 `YYYY-MM-DD`。

变更按用户可感知的行为归纳，不逐条对应 commit；同一版本内按「新增 / 变更 / 修复 / 安全」分组，空分组不列出。

## [Unreleased]

`0.1.0` 尚未发布（无 tag、未上 npm）；本版本的全部变更记在下方 `## [0.1.0]` 小节。

## [0.1.0] - 2026-11-11

首个版本（**尚未发布到 npm**，也无对应 tag）：在本地 DSH 里通过 SSH 使用服务器上的远端 DSH，
整窗呈现远端界面，本地只负责连接与状态。

### 新增

- **连接窗口显示连接日志**：点开尚未连接的主机时，浮窗上半是分阶段进度（指纹确认 / 错误卡片），下半是这台
  连接的逐行日志（SSH 目标与指纹、探测结果、托管 Node 下载安装、`npx` 取包、远端启动、隧道与界面校验、
  失败原因），等宽、按级别着色、自动跟随。关窗不中断连接，连上后自动闭合并接管整窗，失败时日志与错误一起
  保留。日志通过 `HostView.logs` 随 `/state`（SSE 或轮询）下发，只在连接窗口打开时携带、最多 120 行，
  目标解析到 token 交换的每一步也由 Host 记录；API 契约升到 **2.2**（移除未使用的 `POST /hosts/:id/password`、`POST /hosts/:id/keepalive` 与诊断里的 `serverStatus`）。
- **私钥文件浏览与密码保存**：`GET /keyfile/list` 与客户端「选择文件…」弹窗（目录可进入、文件可选中），
  Host 自己列目录、只读、限制在用户主目录内并拒绝 `..` 与符号链接逃逸；勾选保存的 SSH 密码写入 DSH
  凭据存储（插件自有记录空间 `dsh-remote-go:ssh-password:<hostId>`），重连自动复用，`hosts.json` 里永远
  没有密码，没有凭据服务时明确提示只能本次使用。该存储是「仅当前用户可读的明文 YAML」而非加密库。
- **诊断新增「远端 Node 运行时」检查**：固定检查表由 9 项增至 10 项（SSH 可达性、认证、主机指纹、隧道、
  远端服务、远端界面、远端 Node、版本、模型凭据、远端桌面守卫）；托管 Node 安装失败新增错误
  `remote-node-install-failed`。

### 变更

- **主机条成为唯一入口与切换器**：本地页面和远端页面顶部各有一条，由同一段脚本绘制；列出「本地」、每台
  远端主机（右侧带地址）、「添加主机」与「管理界面」。已连接是绿色发光点，未连接 / 断线是灰点；已连接行
  悬停出现「断开」；切回已打开过的远端不重新加载。随之删除侧边栏入口、`main` 主面板、设置面板里的插件
  页面、单独的「刷新远端界面」与「离开远端」。
- **添加 / 编辑主机只保留「保存」与「连接」**：去掉「连接测试」和测试后的「完成」两步；「保存」只记配置
  并关窗，「连接」保存后立即连接（密码认证时表单里的密码直接用于这一次连接）。所有管理界面改为
  `shell.overlay` 浮窗：远端开着时浮在远端之上，关掉回到原来那页。
- **远端窗口与本地窗口改用同一套栅格**：carrier 铺满整窗，并把桌面窗口标题栏标记
  （`data-windows-titlebar` + 高度 + 全屏标记）注入 guest，远端页面自己让出标题栏那一条；注入失败或窗口
  本没有这条带（macOS / Web 构建）时退回「整体下移一条」，任何时候都只有一条标题栏。guest 盖住标题栏后
  由 carrier 的拖拽条补回窗口拖拽，宿主标题栏菜单抬到 guest 之上。
- **全部界面按同一套视觉语言重做并完整跟随 DSH 主题**：主机条、清单、向导、诊断、设置、密码 / 冲突弹窗、
  密钥选择器与 toast 统一间距、圆角、层次、按钮与输入框状态、状态点、滚动条和焦点环；尊重「减少动态效果」
  「增强对比度」「强制颜色」。颜色、圆角、阴影与字体直接读取 `--dsw-*`（无本地 token 层、无 `:root` 变量、
  无颜色字面量），表面语义沿用宿主 Dialog / MenuSurface / 遮罩 / 输入框的 token 组合，内置亮暗、第三方
  主题与 `ctx.theme.overrideTokens()` 覆盖层都即时生效。
- **远端运行时收敛到插件托管 Node**：连接时总用插件自己的 Node——即使远端已装 Node 也不借用；版本 = 本机
  DSH `engines.node` 下限（当前 `>=24.9.0` → Node 24.9.0），已装同版本即复用。首次连接从 nodejs.org 下载
  官方 Linux 构建，用官方 `SHASUMS256.txt` 校验 SHA-256 后解压到 `~/.dsh/remote-go/node/v<version>`；
  官方源不可达回退 npmmirror.com 的同一版本，**没有系统 Node 兜底**。日志、run 注册表、托管 Node、下载缓存
  固定在该目录（删除设置项 `bootstrap.remoteDir`，旧 `~/.dsh-remote-go/` 不再读取或迁移）；`RemoteView`
  新增 `nodeSource`，进度新增 `downloading-node` / `installing-node`。`settings.bootstrap` 只剩
  `{ profile }`（默认 `web`，拒绝 `desktop`），删除 `bootstrap.targetVersion` / `mode` / `nodeVersion`，
  主机条目不再保存 `bootstrap`；`HostView.targetVersion` 恒等于本机版本，`bootstrapLevel` 恒为 `npx`。
  npx 预检不再设超时，冷缓存下载的 npm 输出流式映射为 `bootstrap-first-run` / `bootstrap-fetching` /
  `bootstrap-installed` 进度。
- **远端启动的稳健性**：手工启动的 DSH 会被检测并暂停为 `conflict-pending`（选择停止 / 并存 / 取消，
  120s 未选择按取消处理）；启动前检查远端 profile 的 bundle，只在需要时对本次启动重新启用 `api-remotes`
  （不改用户 profile），旧启动方式留下的实例按 run 注册表标记识别并先停止。
- **呈现方式收敛为整窗接管**：远端 DSH 由桌面端以 Chromium guest 铺满窗口，不再有内嵌、浮层或独立窗口
  形态；删除 `windowMode` 设置、iframe 视口与视窗工具条、iframe 沙箱与 `blocked-iframe`、`window.open`
  逃生通道、右上角浮层胶囊，以及只服务于它们的 i18n 文案。每台主机一个热窗口（独立 partition，不设数量
  上限），切走只隐藏不销毁，断开 / 删除 / 卸载时才释放；加载失败过的窗口下次显示自动重载一次。
- **移除镜像 / 会话子系统**：删除远端会话镜像（L1 目录、L2 历史回放、L3 轮询跟随）、写入租约 / 围栏、
  本地镜像会话与侧边栏工作区注册，以及只服务它们的模块（`mirror*.js`、`history.js`、`lease.js`、
  `session-adapter.js`、`workspace-adapter.js`、`workspaces.js`）；移除五个设置项（`mirrorToSidebar` /
  `mirrorMaxSessions` / `mirrorMaxEvents` / `mirrorHistory` / `mirrorStream`）、镜像与工作区 HTTP 端点
  及客户端镜像轮询；API 契约升到 **2.0**。面板内的「工作区」栏与相关样式、文案一并移除。
- **SSH 认证只剩「私钥文件」与「密码」**：移除 SSH Agent 通道（不再读 `SSH_AUTH_SOCK` /
  Windows OpenSSH 管道，也不再提供 `agent` 候选），默认认证改为 `key`，旧 `agent` 加载时迁移为 `key`；
  新增 `defaultKeyPath`（默认 `~/.ssh/id_ed25519`），密钥路径一律按**用户主目录**展开。
- **最低 DSH 版本提高到 `0.2.2-rc.3`**：界面只注册在 `shell.overlay` 插槽，`engines.dsh` 由
  `>=0.2.2-rc.1` 改为实际验证过的 `>=0.2.2-rc.3`，避免在没有该插槽的版本上静默失效。
- **文档与代码同步收敛**：README、`docs/` 与市场条目改写为「托管 Node + npx、无镜像子系统」的当前行为；
  删除 `docs/session-design.md`、V0 可行性报告与早期调研报告；代码与文档不再引用行号。

### 修复

- **在远端点「断开」回到本地后，主机条仍写着那台远端的名字**：断开意图经浮层宿主挂载时建立的订阅返回，
  订阅捕获的窗口目标仍是挂载那一刻的值，「把窗口交回本地」的判断因此看不见真正在用的主机；现在按实时
  目标收尾，正在显示的远端窗口被释放（断开、删除）时主机条同步回落到「本地」，释放其他热窗口不影响主机条。
- **主题与配色错误**：主机条展开后的空白区域也显示手型光标（菜单表面改为 `cursor:default`）；主机条状态点与「断开」按钮此前读不存在的 `--dsw-alias-state-success` 等变量，改用 `--dsw-alias-state-*-primary`、品牌色与焦点环；主按钮文字由 `--dsw-alias-label-primary-inverted` 改为与 `--dsw-alias-button-primary-fill` 成对的 `--dsw-alias-label-primary-foreground`。
- **管理界面 / 向导底色与 DSH 不一致**：对话框由 `--dsw-alias-bg-overlay` 改为宿主 Dialog 实际使用的 `--dsw-alias-bg-layer-2` + `--dsw-radius-panel` + `--dsw-elevation-prominent` 并去掉描边；下拉菜单改用 `--dsw-specific-menu` + `--dsw-menu-backdrop-filter`；向导去掉重复编号与「第 N 步，共 3 步」副标题。
- **向导步骤、诊断列表、抽屉与设置分区没有样式**：上一轮删除侧边栏脚注规则留下的未闭合 `/*` 吞掉了其后
  约 45 行 CSS；现已恢复并重建，单元测试增加「注释必须闭合」与「每个界面选择器必须有生效声明块」的守护。
- **其它修复**：连接期间发生的 SSH 错误不再导致 Host 侧崩溃（改为分类错误返回并在界面展示原因与下一步）；
  修复 CI 在干净 runner 上无法校验 workflow YAML 的问题（补齐 YAML 解析依赖）。

### 安全

- **零运行时依赖 + 无安装期脚本**：`dependencies: {}`，安装不会执行第三方代码；`ssh2` 由 `scripts/build-vendor.mjs` 打包为 `vendor/ssh2.bundle.cjs` 随包分发，安装不拉取任何依赖。
- **回环硬规则**：远端 DSH 只绑 `127.0.0.1`，本地隧道也只监听 `127.0.0.1`；guest 只接受 `http://127.0.0.1:<port>`，客户端再次校验前缀后才交给桌面端。
- **凭据最小化**：SSH 密码默认只用于本次连接（内存），勾选保存才写入 DSH 凭据存储；launch token 默认只在内存，显式开启后以 0600 保存；本地持久化目录 0700、文件 0600 且为原子写。
- **主机指纹**：首次连接显式确认、接受后记录 pin、指纹变化强提示并阻断、`strict` 策略直接拒绝未记录的主机。
- **本地 HTTP API 鉴权**：要求自定义请求头 + 同源 `Origin` + 拒绝 `sec-fetch-site: cross-site`；`/events`（EventSource 无法加头）只做 Origin 栅栏；跨站请求一律 403。
- **发布物与自举白名单**：tarball 只含运行时文件，无 postinstall / build 脚本；Node 下载、`npx` 精确版本、远端启动都走固定命令模板，不接受调用方拼接的任意 shell，下载校验 SHA-256。
- **脱敏**：诊断导出默认屏蔽 token、密码、私钥与家目录，降低贴日志时的泄漏风险。

[Unreleased]: https://github.com/Solaris136/dsh-remote-go/commits/main
