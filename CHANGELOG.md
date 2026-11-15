# Changelog

> **English abstract.** Notable, user-visible changes to `dsh-remote-go`, newest first. The format follows
> Keep a Changelog 1.1.0 and versions follow Semantic Versioning 2.0.0; entries are written in Chinese and
> describe behavior rather than individual commits.

本文件记录用户可感知的变更，格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)，日期为 `YYYY-MM-DD`。

## [Unreleased]

`0.1.0` 尚未发布（无 tag、未上 npm）。

### 新增

- **本地 → 远端同步（可选、逐主机）**：添加 / 编辑主机的高级选项里勾选「同步 API key / 登录状态」或
  「同步插件与插件配置」后，连接时按本机版本从 registry 安装插件、合并可移植的配置行、写入远端
  `~/.dsh/.credentials.yaml`（refs 本地覆盖、records 只增不改）；远端独有内容保留，先备份、校验失败
  自动回滚。新增 `POST /hosts/:id/sync`、`HostView.sync` 与 `sync-*` 进度码。

### 变更

- **默认私钥路径改为 `~/.ssh/id_rsa`**：向导预填更通用的默认名；配置的路径不存在时，仍按
  `id_ed25519 → id_rsa → id_ecdsa` 的顺序兜底。

## [0.1.0] - 2026-11-11

首个版本：在本地 DSH 里通过 SSH 使用远端 DSH，整窗呈现远端界面，本地只负责连接与状态。

### 新增

- **连接窗口**：上半是分阶段进度（指纹确认 / 错误卡片），下半是逐行连接日志（SSH 目标与指纹、托管 Node
  下载、`npx` 取包、远端启动、隧道、界面校验），最多 120 行、随 `/state` 下发；关窗不中断连接，连上后
  自动闭合并接管整窗。
- **私钥浏览与密码保存**：`GET /keyfile/list` +「选择文件…」弹窗，只读且限制在用户主目录内（拒绝 `..`
  与符号链接逃逸）；勾选保存的 SSH 密码写入 DSH 凭据存储，`hosts.json` 永不保存密码。
- **诊断**：固定 10 项检查（含「远端 Node 运行时」），托管 Node 安装失败新增错误 `remote-node-install-failed`。

### 变更

- **主机条成为唯一入口**：本地与远端页面顶部各一条，列出「本地」与每台主机；已连接显示绿点、悬停出现
  「断开」，切回已打开的远端不重新加载；删除侧边栏入口、主面板与设置页入口。
- **整窗接管**：桌面端以 Chromium guest 铺满窗口，远端页面让出标题栏一条（失败时整体下移）；删除内嵌 /
  浮层 / 独立窗口形态、iframe 沙箱与相关设置和文案，每台主机一个热窗口。
- **托管 Node**：连接总用插件自己的 Node（版本 = 本机 `engines.node` 下限），官方 tarball + SHA-256 校验，
  官方源不可达回退 npmmirror，**没有系统 Node 兜底**；`bootstrap` 设置收敛为 `{ profile }`。
- **SSH 认证**只剩「私钥文件」与「密码」（移除 Agent 通道），新增 `defaultKeyPath`，密钥路径按用户主目录展开。
- **移除镜像 / 会话子系统**（含镜像、租约、历史回放、工作区注册），API 契约升到 **2.0**；随后连接日志
  相关契约升到 **2.2**，移除未使用的 `POST /hosts/:id/password` 与 `/keepalive`。
- **最低 DSH 版本提高到 `0.2.2-rc.3`**：界面只注册在 `shell.overlay`，只在验证过的版本上启用。
- **界面按 DSH 主题重做**：颜色、圆角、阴影与字体直接读取 `--dsw-*`（无本地 token 层、无颜色字面量），
  尊重「减少动态效果」「增强对比度」「强制颜色」，第三方主题与 `overrideTokens()` 覆盖即时生效。
- **文档与市场条目**同步为「托管 Node + npx、无镜像子系统」的当前行为，删除过期设计文档。

### 修复

- 断开后主机条仍显示远端名：按实时目标收尾，释放正在显示的远端窗口时回落到「本地」。
- 主题与配色：主机条光标、状态点与「断开」按钮的错误变量、主按钮文字配色、对话框/下拉菜单底色。
- 向导步骤、诊断列表、抽屉与设置分区样式缺失（未闭合 CSS 注释吞掉规则），并新增注释闭合与选择器守卫。
- 连接期间的 SSH 错误不再导致 Host 崩溃；修复 CI 在干净 runner 上校验 workflow YAML 的问题。

### 安全

- **零运行时依赖 + 无安装期脚本**：`ssh2` 预打包进 `vendor/` 随包分发，安装不拉取依赖、不执行第三方代码。
- **回环硬规则**：远端与本地隧道都只监听 `127.0.0.1`，guest 只接受回环地址。
- **凭据最小化**：密码默认只在内存，保存时进 DSH 凭据存储；launch token 默认只在内存，落盘时 0600；
  本地状态目录 0700、文件 0600 且原子写。
- **主机指纹**：首次确认、接受后记录、变化阻断，`strict` 策略拒绝未记录的主机。
- **本地 API 鉴权**：自定义请求头 + 同源 `Origin`，拒绝跨站 `sec-fetch-site`；跨站请求一律 403。
- **发布物与自举白名单**：tarball 只含运行时文件、无生命周期脚本；Node 下载、`npx` 版本与远端启动都走固定
  命令模板，下载校验 SHA-256。
- **脱敏**：诊断导出默认屏蔽 token、密码、私钥与家目录。

[Unreleased]: https://github.com/Solaris136/dsh-remote-go/commits/main
