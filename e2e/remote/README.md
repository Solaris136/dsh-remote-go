# e2e/remote · 远端测试环境（历史：隔离运行时）

> **当前插件已不再使用本目录的隔离运行时。** 插件的远端运行时是 npx-only：远端 DSH 由插件用
> `npx -y @deepseek-ai/dsh@<本机版本> --profile <profile> --no-open --port 0` 启动，`DSH_HOME` 就是远端用户真实的
> `~/.dsh`；不下载 Node、不安装到私有 prefix、不做隔离 home。真实主机验收现在只需要远端满足：
> Linux、Node ≥ 24.9.0、npm/npx、curl、首次运行能访问 npm registry。插件自己负责启动/停止远端 web。
>
> 下面 `setup-remote.sh` / `start-remote.sh` / `remote.ps1` 的隔离运行时流程是 0.1.0 早期的真实主机验收工具，
> 保留用于回看历史证据与旧版本排障；**不要**在插件连接期间执行它们，否则会争用远端 `~/.dsh` 或端口。

本目录用于在一台可 SSH 访问的 Linux 测试机上建立**与本地同版本**的隔离 DSH Web 运行时（历史路径），
供旧版插件的真实主机验收与排障使用。仓库不包含测试主机地址或凭据；所有命令通过 `DSH_REMOTE_HOST`（SSH 别名或 `user@host`）指定目标主机。

> 早期的 V0 可行性验证（同站 loopback iframe）已随该呈现方式一起退役：产品改为桌面端 Chromium guest 接管主内容区，
> 当时的结论报告不再随仓库保留，可从 git 历史取回。

## 目录与文件

| 文件 | 作用 |
|---|---|
| `setup-remote.sh` | **历史**：远端执行：下载/校验/解压 Node v24.22.2，npm 安装精确版本 dsh 到私有 prefix，验证版本。幂等。当前插件不使用。 |
| `start-remote.sh` | **历史**：远端执行：用隔离 `DSH_HOME` 以 `setsid+nohup` 启动 `dsh --profile web --no-open --port 0`，解析 `dsh web:` 行，写 `run/{web.pid,web.port,web.token,web.url,web.state.json}`。幂等（存活则复用，`RESTART=1` 强制重启）。当前插件不使用。 |
| `stop-remote.sh` | 远端执行：向进程组发 SIGTERM，等待/兜底 SIGKILL，清理 run 状态。幂等。 |
| `status-remote.sh` | 远端执行：**只读**检查运行时版本/磁盘/目录/记录态与「当前有哪些进程在用这个运行时」以及监听端口。 |
| `setup-self-ssh.sh` | 远端执行：可选，添加 `Host self` 自环 SSH 别名（幂等）。 |
| `remote.ps1` | Windows 本地驱动：上传脚本（base64+md5 校验）、执行 setup/start/status/stop、管理 `ssh -N -L` 隧道、写 `.state.json`。 |
| `curl-check.ps1` | 本地：经隧道跑全部 curl 检查，写 `evidence/*.headers.txt` 与 `evidence/curl-check.result.json`（token/cookie 值自动打码）。 |
| `embed-check/` | 本地：V0 时代的 puppeteer iframe 验证工具（当前产品不再内嵌 iframe，保留仅供考古与证据溯源）。 |
| `evidence/` | 实测证据（头信息、结果 JSON、截图、采集文本）。 |
| `.state.json` | 运行/交接状态（**不含 token**）。 |

## 运行约定

- **历史隔离运行时**（仅旧版插件）：`~/.dsh-remote-go/{node,dsh-home,home}`（Node `v24.22.2` + `@deepseek-ai/dsh@0.2.2-rc.1`），
  具体路径与最后一次启动参数见 `.state.json`。当前插件不读取这些目录，也不会收养这里的进程。
- **当前插件**：远端数据在 `~/.dsh`；插件自己的日志/run/租约在 `~/.dsh-remote-go/{logs,run,remote-go}`。插件连接期间不要用
  `start-remote.sh` / `remote.ps1 start` 另起一个 web，否则会争用同一个 `~/.dsh` profile。
- 只读检查随时可用：`bash ~/.dsh-remote-go/scripts/status-remote.sh`（不会启动/停止任何进程，也不碰 `DSH_HOME`）。
- 远端 `~/.ssh/config` 已有 `Host self`（127.0.0.1 自环登录，可选实验用；见 `setup-self-ssh.sh`）。

## 前置条件

- 本地：Windows + PowerShell 7（`pwsh`）；`ssh <你的主机别名>` 免密可用；Chrome 或 Edge。
- 运行时：Node ≥ 24 与 pnpm ≥ 11 在 PATH 中即可；若不在 PATH，用环境变量覆盖：
  - `DSH_NODE`：node 可执行文件（`run-check.ps1` 使用）
  - `DSH_PNPM`：pnpm 的 JS 入口（如 `pnpm.cjs`/`pnpm.mjs`）
  - `CHROME_PATH`：Chrome/Edge 可执行文件
- 远端（**当前插件**）：Ubuntu 24.04 + Node ≥ 24.9.0 + npm/npx + curl；首次运行能访问 npm registry。
  不再要求 tar/xz/sha256sum，也不要求 nodejs.org。
- 远端（**历史隔离运行时**）：`curl/tar/xz/sha256sum/setsid/nohup/ss/pgrep/base64` 可用；能访问 nodejs.org 与 npm registry。

## 当前插件：npx-only 真实主机验收

不需要在本目录做任何“自举”。在远端确认：

```bash
node -v        # >= 24.9.0
command -v npx
command -v curl
```

然后在本地 DSH 的 **设置 → 远程主机** 添加主机并点「打开」：插件会先跑一次
`npx -y @deepseek-ai/dsh@<本机版本> --version` 预检（冷缓存下载发生在这里），再用
`DSH_HOME=~/.dsh npx ... --profile web --no-open --port 0` 启动远端；远端数据直接在 `~/.dsh`。
失败时看连接错误卡片与远端 `~/.dsh-remote-go/logs/web.log`。

## 历史：隔离运行时复跑步骤

所有命令在仓库根目录执行。

### 1) 历史：远端隔离运行时准备（幂等，已装则秒级跳过）

```powershell
pwsh -File e2e/remote/remote.ps1 setup
```

等价的手工方式（在远端执行）：

```bash
bash ~/.dsh-remote-go/scripts/setup-remote.sh
# 期望结尾：SETUP_OK + DSH_VERSION=0.2.2-rc.1
```

### 2) 历史：启动隔离远端 web + 本地隧道

```powershell
pwsh -File e2e/remote/remote.ps1 start
```

它会：启动远端 web（`--port 0`，OS 分配端口）→ 解析 `dsh web: http://127.0.0.1:<port>/?token=...` → 把 token 写入远端 0600
文件后取回本地 `.token` → 起 `ssh -N -L` 隧道 → 写 `.state.json`。

> 注意：`ssh -N` 隧道是长生命周期子进程，在被 agent 工具前台调用时可能因「仍有子进程」而不返回（会被转后台）。
> 手动复跑建议单独开一个终端执行 `remote.ps1 start`，或用 `remote.ps1 tunnel-start` 单独维持隧道；`.state.json` 写好后即可继续。

期望关键输出：`REUSED=0`、`PORT=<port>`、`STARTUP_SECONDS≈6`、`REMOTE_PROBE_HTTP=401`、`tunnel up ... probe 401`。

### 3) token/cookie/HTTP 证据

```powershell
pwsh -File e2e/remote/curl-check.ps1    # 期望 summary: 18/18 passed
```

输出：`evidence/curl-check.result.json`、`evidence/01-*.headers.txt` … `evidence/13-*`。

### 4) 状态检查（只读，插件运行期间也可安全执行）

```powershell
pwsh -File e2e/remote/remote.ps1 status
```

远端直接执行：`bash ~/.dsh-remote-go/scripts/status-remote.sh`。它会列出运行时版本、`RUNTIME_WEB_PROCESS_COUNT`、
各进程 PID/端口/监听、`DSH_HOME` 目录树、日志尾部（token 打码）。

### 5) 历史：停止（自管模式；当前插件不使用）

```powershell
pwsh -File e2e/remote/remote.ps1 stop
```

停止远端进程组 + 本地隧道，清理远端 `run/` 与本地 `.token`，`.state.json` 标记 `status=stopped`。

## 手工调试：自起一个 web 并拿端口/token

**当前插件等价命令**（数据在远端自己的 `~/.dsh`）：

```bash
DSH_HOME=$HOME/.dsh setsid nohup \
  npx -y @deepseek-ai/dsh@<本机版本> --profile web --no-open --port 0 \
  >> $HOME/.dsh-remote-go/logs/remote-web.log 2>&1 &
grep -Eo 'dsh web: http://127.0.0.1:[0-9]+/\?token=[^ ]+' $HOME/.dsh-remote-go/logs/remote-web.log
```

**历史隔离运行时命令**：

```bash
ROOT=$HOME/.dsh-remote-go
$ROOT/node/bin/node $ROOT/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js --version   # 0.2.2-rc.1
DSH_HOME=$ROOT/home setsid nohup $ROOT/node/bin/node \
  $ROOT/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --port 0 \
  >> $ROOT/logs/remote-web.log 2>&1 &
# 轮询日志：
grep -Eo 'dsh web: http://127.0.0.1:[0-9]+/\?token=[^ ]+' $ROOT/logs/remote-web.log
```

拿到 `<port>`/`<token>` 后本地：`ssh -N -L 127.0.0.1:<port>:127.0.0.1:<port> <你的主机别名>`，浏览器/curl 打开
`http://127.0.0.1:<port>/?token=<token>`（首次会 303 到干净 URL 并种 cookie，之后不再需要 token）。

## 已知坑与规避

1. **必须用回环 authority**：cookie 名是 `dsh-auth-<base64url(sha256(Host))>` 且 `SameSite=Strict`；跨 site 地址（公网域名 /
   Tailscale IP / 非回环 IP）会 401/403。本地一律 `127.0.0.1`，不要混用 `localhost`。
2. **（历史隔离运行时）npm 11 的 install-scripts 门禁**：`npm install` 默认不跑依赖安装脚本；旧栈真正需要的是
   `@deepseek-ai/dsh-subprocess-local` 的 postinstall（给 node-pty 的 helper 补可执行位），`setup-remote.sh` 已直接执行该幂等脚本；
   `node-pty`/`koffi` 的原生模块随包自带 prebuild，无需编译工具链。当前 npx 路径由 npm 的包安装负责，不改这个门禁。
3. **（历史隔离运行时）长安装步骤防 SIGHUP**：本地 SSH 瞬时断开会让远端 npm 安装被 SIGHUP 中断（文件已落盘）。重跑幂等脚本即恢复。
   当前 npx 路径把进程放在 `setsid/nohup` 下，并从远端日志判断就绪。
4. **IPv6 链路抖动**：本地→VM 的 IPv6 偶发超时（`ssh: banner exchange` 超时）。`remote.ps1` 对 ssh 调用有重试，仍建议失败后
   隔几秒重试；仍不通时先 `Test-NetConnection <主机地址> -Port 22`。
5. **空工作区**：远端 `~/.dsh/storages/workspace.json` 为空时，首屏会弹「预览版说明」+「无法创建默认工作区」toast，composer 不出现；
   E2E 若要会话操作需先选工作区或预置 workspace。
6. **单实例**：同一 `DSH_HOME` 不要并发跑多个 web 进程；插件按注册表收养自己的进程，但不会接管手工启动的实例。

## 证据文件（历史）

- `evidence/curl-check.result.json`：18 项 HTTP/cookie/API 栅栏/WS 检查（全 PASS）。
- `evidence/01-token-exchange.headers.txt`：303 + Set-Cookie（cookie 值已打码）。
- `evidence/02-authenticated.*`：二次访问 200 + HTML（含无 XFO/CSP 的证据头）。
- `evidence/03-unauthenticated.*`：401 对照。
- `evidence/04..12-*`：API Host/Origin/Sec-Fetch-Site 矩阵与 WS 101/403。
- `evidence/embed-check.result.json` + `embed-check.png`：V0 时代 puppeteer iframe 验证与截图（历史）。
- `evidence/handover-verification.txt`：停止验证 + `Host self` 自环 SSH 验证。
