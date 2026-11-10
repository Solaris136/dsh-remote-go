# dsh-remote-go · dsh remote go

> 在本地 DeepSeek Harness（DSH）里，通过 SSH 整页使用服务器上的 DSH。本地只负责连接、入口与状态。

[![CI](https://github.com/Solaris136/dsh-remote-go/actions/workflows/ci.yml/badge.svg)](https://github.com/Solaris136/dsh-remote-go/actions/workflows/ci.yml)

**状态：V1.0 实现完成（2026-11-11）** —— 设计文档 v0.6 中的 V1.0 范围已全部落地，含完整单元测试与真实测试主机上的端到端验收。

| 证据 | 结果 |
|---|---|
| 单元测试 | `node --test "test/unit/*.test.js"` → 169 用例全部通过（Host + Client） |
| 端到端（真实 SSH + 真实远端 DSH + 真实浏览器） | `node --test "test/e2e/*.e2e.js"` → 通过；证据 `e2e/artifacts/plugin-e2e-report.json` 与截图 `settings-remote-section.png`、`panel-workspace-rail.png`、`panel-remote-dsh.png`（含工作区按远端分组断言） |
| 发布路径 | `pnpm pack` → tarball 仅含运行时文件 → 安装进干净 profile → API 与 client-module 均从安装目录加载（`e2e/artifacts/publish-e2e-report.json`） |
| CI | GitHub Actions：ubuntu/windows × Node 24 单测 + 打包/市场条目校验；手动触发的真实主机 E2E |
| V0 可行性闸门（专项） | `e2e/remote/v0-report.md`：同站 loopback iframe 可嵌入，无需同源反代 |
| 测试主机 | `43.133.80.40` / `240d:c000:f05f:8d00:327e:8b66:5c18:0`（Ubuntu 24.04，仅 IPv6 回程可用） |

- 设计文档：[docs/design.md](docs/design.md)
- 实现说明：[docs/implementation.md](docs/implementation.md)
- 本地插件 API 契约：[docs/api.md](docs/api.md)
- 发布与插件市场：[docs/publish.md](docs/publish.md)
- 同类项目调研：[docs/research-competitors.md](docs/research-competitors.md) · [docs/research-dsh-remote-window.md](docs/research-dsh-remote-window.md)

## 它是什么

- 一个 DSH 插件：主机在 **设置 → 远程主机** 里配置，打开后在**全局面板**里整页使用远端 DSH（**不占用侧边栏入口**）。
- 面板里是一整页**远端 DSH 自己的 Web 界面**（同站 loopback iframe），会话、审批、文件、终端、插件、凭据、日志都由远端 DSH 提供。
- 本地只做四件事：**主机清单、SSH 连接与隧道、全局面板承载、连接状态与诊断**。
- 远端只需原版 DSH（`@deepseek-ai/dsh`）——没有环境时由插件自举（无 root，装到用户目录）。

## 功能（V1.0 已实现）

| 能力 | 状态 |
|---|---|
| **设置页「远程主机」**：主机清单 / 添加 / 编辑 / 删除 / 多主机切换 | ✅ |
| **面板左侧「工作区」栏**：本地工作区 + 按远端分组 / 远端工作区，点击本地工作区回本地会话 | ✅ |
| 不占用侧边栏入口（入口在设置页与面板内） | ✅ |
| 接入向导 3 步（SSH 信息 → 连接测试 → 远端探测/完成） | ✅ |
| SSH 别名自动发现（`~/.ssh/config`）、known_hosts 只读解析 | ✅ |
| 主机指纹：首次确认 / 记录 / 变化强提示 / strict 策略 | ✅ |
| 认证：SSH Agent / 密钥文件 / 一次性密码（不落盘） | ✅ |
| 跳板机（跳板 SSH → forwardOut → 目标 SSH） | ✅ |
| 全局面板整页呈现远端 DSH（同站 loopback iframe） | ✅ |
| 视窗工具条：状态点、重连、刷新、切主机、新窗口打开、返回 | ✅ |
| 连接状态 / 分阶段进度 / 断线自动重连 | ✅ |
| 诊断检查表（9 项）+ 复制脱敏诊断信息 | ✅ |
| 远端环境自举 T0/T0-local/T1/T2/T3（T4 离线包为 V1.1 预留） | ✅ |
| 版本一致性：目标版本 = 本机 DSH 版本，不一致不静默混用 | ✅ |
| 远端存活策略：保持运行 / 退出即停 / 空闲停止（按主机） | ✅ |
| 隧道收养（本地重启后复用仍在运行的远端实例） | ✅ |
| 设置（窗口/SSH 默认值/自动重连/指纹策略/保存令牌开关/自举参数） | ✅ |
| 双语界面（中文 / English） | ✅ |
| 沉浸模式 / 通知 / 远端设置管理 / 运维升级 | ⏳ V1.1+ |

## 安装

### 方式 1：本地目录安装（开发 / 自用）

```bash
dsh plugin --profile web add /absolute/path/to/dsh-remote-go
```

或在 DSH 的 **Settings → Plugins** 里以插件包目录安装。安装后刷新页面，打开 **设置 → 远程主机** 即可管理服务器。

### 方式 2：npm / 插件市场

```bash
dsh plugin --profile web add dsh-remote-go
```

发布流程见 [docs/publish.md](docs/publish.md)；索引条目由 `node scripts/market-entry.mjs` 生成并用官方 `dsh-plugin-market-index` 校验。

## 快速开始

1. 打开 **设置 → 远程主机** →「添加第一台服务器」。
2. 填 SSH 地址或 `~/.ssh/config` 别名（可用 Agent / 密钥 / 一次性密码；可选跳板机）。
3. 首次连接确认主机指纹（可「接受并记住」）。
4. 插件探测远端环境：能连 SSH 后自动选择自举级别并启动远端 DSH，等待进入「已连接」。
5. 点「打开远程界面」：远端 DSH 在面板中整页打开；面板左侧「工作区」栏会列出「本地工作区」和每台远端的工作区（按远端分组），点击本地工作区可回到本地会话。
6. 关闭视窗只关闭本地承载，远端任务继续（按主机的存活策略）。

### 远端自举分级（D0–D5，对应设计 §16.2）

| 级别 | 触发条件 | 行为 |
|---|---|---|
| T0 | 远端已有本机同版本 DSH 且在 PATH/常见位置 | 直接复用 |
| T0-local | `~/.dsh-remote-go/` 已有插件此前准备的隔离运行时 | 直接复用（最快） |
| T1 | 系统 Node ≥ 24.9 且有 npx | `npx -y @deepseek-ai/dsh@<本机版本>`（不全局安装） |
| T2 | 有可用 Node 但 npx 受限 | `npm install --prefix ~/.dsh-remote-go/dsh-home` |
| T3 | 无可用 Node | 下载官方 Node（SHA-256 校验）→ T2 |
| T5 | 连 curl/tar/sha256 都没有 | 明确失败 + 可复制的准备命令（不假装能装） |

所有远端产物在用户目录（默认 `~/.dsh-remote-go/`），无需 root；只绑定回环地址，经 SSH 隧道访问。

## 架构（薄客户端）

```text
本地 DSH（Host 插件 src/ + Client 插件 client.js）
├─ 设置页「远程主机」：主机清单 / 向导 / 诊断 / 插件设置（本地 UI，不占侧边栏入口）
├─ SSH（ssh2）：认证、主机指纹、exec、forwardOut
├─ 远端自举 / 远端 dsh web 生命周期（start/stop/adopt）
└─ 本地回环 TCP 隧道  127.0.0.1:<localPort> ──SSH──▶ 远端 127.0.0.1:<remotePort>
                                                     │
远端服务器：原版 DSH（`dsh --profile web --no-open --port 0`）
└─ 远端 DSH Web 界面 ──同站 loopback iframe──▶ 本地远程面板
                     └─ 面板左侧工作区栏：本地工作区 + 按远端分组
```

关键决策：

1. **同站 loopback iframe，而不是同源反代**：本地 DSH GUI 与隧道端口都是 `127.0.0.1`（同 site、不同 origin），远端 DSH 的 `SameSite=Strict` cookie 可正常种入/持久化；IAB 实测通过（`e2e/remote/v0-report.md`）。这避免了反代的工作量，同时保持「零远端专属组件」。
2. **每台主机独立本地端口**：cookie 按 authority 绑定，多主机登录态天然隔离。
3. **远端自举只使用白名单模板命令**（Node 下载、npx 精确版本、npm 隔离安装），不接受任意 shell。
4. **版本一致**：目标版本取自本机 DSH（`clientModules.graph().release.version`），安装/启动都写精确版本；不一致时给「准备同版本 / 沿用远端 / 取消」，不静默混用。
5. **零运行时依赖、零安装脚本**：`ssh2` 由 `scripts/build-vendor.mjs` 打包成 `vendor/ssh2.bundle.cjs`，发布包 `dependencies: {}`，安装不会执行任何 npm 生命周期脚本（供应链更可控，CI/市场安装更稳）。

更细的模块划分见 [docs/implementation.md](docs/implementation.md)。

## 安全

- 远端界面只绑 `127.0.0.1`，经 SSH 隧道访问；本地也不监听公网。
- SSH 密码仅用于本次连接（内存），不落盘；密钥不上传。访问令牌默认只在内存（可选 0600 保存）。
- 主机指纹首次确认、变化强提示；诊断导出默认脱敏（token/密码/私钥/家目录）。
- 本地 HTTP API 要求同源 + 自定义请求头；跨站请求被拒绝。
- 操作都在远端执行；首次进入提示「你正在操作远端服务器」，关闭时提示「远端任务会继续运行」。

## 开发与测试

```bash
# 单元测试（Host + Client，无需网络/SSH）
node --test "test/unit/*.test.js"

# 端到端：本地独立 control DSH → SSH → 真实测试主机 → 远端 DSH → 无头 Chrome 面板验收
# 前置：e2e/control 已安装 0.2.2-rc.1 运行时、控制 profile 已安装本插件、测试主机可用
node --test "test/e2e/*.e2e.js"

# 发布材料校验（CI 同款门禁）
node scripts/check-syntax.mjs
node scripts/check-workflows.mjs
node scripts/market-entry.mjs --check
node scripts/pack-check.mjs

# 远端专项（V0 证据 / 运行时自举）
#   见 e2e/remote/README.md
```

目录：

```
index.js / client.js        Host / Client 入口（包根）
src/                        Host 插件实现（SSH/自举/隧道/服务/API/诊断）
locale/                     插件市场显示元数据（zh/en）
cordis.patch.yml            插件 bundle patch
test/unit/                  单元测试（node:test）
test/e2e/                   真实端到端验收（control DSH + 无头 Chrome）
e2e/control/                隔离的 control DSH 运行时/启动脚本
e2e/remote/                 测试主机自举脚本与 V0 证据
scripts/                    市场条目/打包校验脚本
docs/                       设计、实现、API、发布文档
```

E2E 需要本机有 Chrome/Edge（`E2E_CHROME` 可覆盖路径），以及可通过 SSH 免密访问的测试主机（`E2E_SSH_ADDRESS`，默认 `tencent-vm`）。

### CI（GitHub Actions）

- `.github/workflows/ci.yml`（push / PR / 手动）：
  - **test**：ubuntu-latest 与 windows-latest × Node 24，`pnpm install --frozen-lockfile --ignore-scripts` → 语法检查 → workflow YAML 校验 → 重建 vendored ssh2 → 单元测试（Host + Client）。
  - **package**：ubuntu/windows 双平台执行市场条目校验（官方 `dsh-plugin-market-index` 解析）、`files[]` 覆盖校验、`pnpm pack` 后对 tarball 内容再校验，并上传 tarball artifact。
- `.github/workflows/e2e.yml`（仅手动触发）：使用仓库 secret `E2E_SSH_PRIVATE_KEY`，在 GitHub runner 上准备独立 control DSH、SSH 到指定测试主机、跑真实端到端（远端自举 + 面板 iframe + 发布物安装），上传诊断与截图 artifact。

发布前本地跑一遍与 CI 相同的门禁即可（见上）；`prepack` 还会自动执行 `market-entry --check`，防止带病发布。

## 已知限制（V1.1+ 范围）

- 不做沉浸模式（`shell.overlay`）、本机通知、多窗口分屏、远端设置 diff/备份管理、离线包自举（T4）。
- 远端仅支持 Linux；Windows 远端待后续版本。
- 内嵌界面的剪贴板/下载/外部链接行为受浏览器 iframe 限制，「在新窗口打开」为逃生通道。
- 刷新本地页面需要重新打开视窗（远端任务不受影响）。
- 修改 Host 插件代码需重启本地 DSH 生效（Client 半端随页面刷新加载）。

## License

MIT（见 [LICENSE](LICENSE)）。



