# e2e/remote · 远端测试环境（历史：隔离运行时）

> **当前插件已不再使用本目录的隔离运行时。** 远端 DSH 由插件用 `npx -y @deepseek-ai/dsh@<本机版本> --profile <profile> --no-open --port 0` 启动，`DSH_HOME` 就是远端用户真实的 `~/.dsh`；Node 由插件自动安装到 `~/.dsh/remote-go/node`（官方 tarball + SHA-256，不碰系统 Node、不做隔离 home）。真实主机验收只需远端满足：Linux、`curl` 或 `wget`、首次连接能访问 nodejs.org（或 npmmirror.com）与 npm registry。
>
> `setup-remote.sh` / `start-remote.sh` / `remote.ps1` 的隔离运行时流程是 0.1.0 早期的真实主机验收工具，保留用于回看历史证据与旧版本排障；**不要**在插件连接期间执行它们，否则会争用远端 `~/.dsh` 或端口。
>
> 早期 V0 可行性验证（同站 loopback iframe）随该呈现方式一起退役；当时的结论报告可从 git 历史取回。

## 目录与文件

| 文件 | 作用 |
|---|---|
| `setup-remote.sh` | **历史**：远端下载/校验/解压 Node v24.22.2，npm 安装精确版本 dsh 到私有 prefix，验证版本；幂等 |
| `start-remote.sh` | **历史**：用隔离 `DSH_HOME` 以 `setsid+nohup` 启动 `dsh --profile web --no-open --port 0`，解析 `dsh web:` 行，写 `run/{web.pid,web.port,web.token,web.url,web.state.json}`；幂等（存活则复用，`RESTART=1` 强制重启） |
| `stop-remote.sh` | 远端 SIGTERM → 兜底 SIGKILL，清理 run 状态；幂等 |
| `status-remote.sh` | **只读**：运行时版本/磁盘/目录/记录态、进程占用与监听端口 |
| `setup-self-ssh.sh` | 可选：添加 `Host self` 自环 SSH 别名（幂等） |
| `remote.ps1` | Windows 本地驱动：上传脚本（base64+md5 校验）、setup/start/status/stop、`ssh -N -L` 隧道、写 `.state.json` |
| `curl-check.ps1` | 本地经隧道跑全部 curl 检查，写 `evidence/*.headers.txt` 与 `curl-check.result.json`（token/cookie 自动打码） |
| `embed-check/` | V0 时代 puppeteer iframe 验证工具（仅考古） |
| `evidence/` | 实测证据（头信息、结果 JSON、截图、采集文本） |
| `.state.json` | 运行/交接状态（**不含 token**） |

## 运行约定

- **历史隔离运行时**（仅旧版插件）：`~/.dsh-remote-go/{node,dsh-home,home}`（Node `v24.22.2` + `@deepseek-ai/dsh@0.2.2-rc.1`），具体路径与最后一次启动参数见 `.state.json`；当前插件不读取这些目录，也不会收养这里的进程。
- **当前插件**：远端数据在 `~/.dsh`，插件自己的日志/run/托管 Node 在 `~/.dsh/remote-go/{logs,run,node,downloads}`。连接期间不要用 `start-remote.sh` / `remote.ps1 start` 另起 web，否则会争用同一个 `~/.dsh` profile。
- 只读检查随时可用：`bash ~/.dsh-remote-go/scripts/status-remote.sh`（不启动/停止进程，也不碰 `DSH_HOME`）。
- 远端 `~/.ssh/config` 已有 `Host self`（127.0.0.1 自环，可选实验；见 `setup-self-ssh.sh`）。

## 前置条件

- 本地：Windows + PowerShell 7（`pwsh`）；`ssh <主机别名>` 免密可用；Chrome 或 Edge。
- 运行时：Node ≥ 24 与 pnpm ≥ 11 在 PATH；否则用环境变量覆盖：`DSH_NODE`（node 可执行文件，`run-check.ps1` 使用）、`DSH_PNPM`（pnpm 的 JS 入口，如 `pnpm.cjs`/`pnpm.mjs`）、`CHROME_PATH`（Chrome/Edge）。
- 远端（**当前插件**）：Ubuntu 24.04 + `curl` 或 `wget`；首次连接能访问 nodejs.org（或 npmmirror.com）与 npm registry。不再要求预装 Node、tar/xz/sha256sum。
- 远端（**历史隔离运行时**）：`curl/tar/xz/sha256sum/setsid/nohup/ss/pgrep/base64` 可用，能访问 nodejs.org 与 npm registry。

## 当前插件：托管 Node 的真实主机验收

不需要在本目录「自举」。远端确认 `command -v curl || command -v wget`，然后在本地 DSH 的**主机条**（侧边栏顶部）里点「添加主机」，再从列表点「打开」：插件先把托管 Node 准备到 `~/.dsh/remote-go/node`（首次下载官方 tarball 并校验），再跑 `npx -y @deepseek-ai/dsh@<本机版本> --version` 预检（冷缓存下载在这里），最后用 `DSH_HOME=~/.dsh <托管 npx> ... --profile web --no-open --port 0` 启动；远端数据直接在 `~/.dsh`。失败时看连接错误卡片与远端 `~/.dsh/remote-go/logs/web.log`。

## 历史：隔离运行时复跑步骤

所有命令在仓库根目录执行。

### 1) 远端隔离运行时准备（幂等，已装则秒级跳过）
```powershell
pwsh -File e2e/remote/remote.ps1 setup
```
等价手工方式（远端执行）：`bash ~/.dsh-remote-go/scripts/setup-remote.sh`，期望结尾 `SETUP_OK` + `DSH_VERSION=0.2.2-rc.1`。

### 2) 启动隔离远端 web + 本地隧道
```powershell
pwsh -File e2e/remote/remote.ps1 start
```
它会：启动远端 web（`--port 0`，OS 分配端口）→ 解析 `dsh web: http://127.0.0.1:<port>/?token=...` → 把 token 写入远端 0600 文件后取回本地 `.token` → 起 `ssh -N -L` 隧道 → 写 `.state.json`。

> `ssh -N` 隧道是长生命周期子进程，被 agent 工具前台调用时可能因「仍有子进程」而不返回（会被转后台）。建议单独开终端执行 `remote.ps1 start`，或用 `remote.ps1 tunnel-start` 单独维持隧道；`.state.json` 写好后即可继续。

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
远端直接执行：`bash ~/.dsh-remote-go/scripts/status-remote.sh`。它列出运行时版本、`RUNTIME_WEB_PROCESS_COUNT`、各进程 PID/端口/监听、`DSH_HOME` 目录树、日志尾部（token 打码）。

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
grep -Eo 'dsh web: http://127.0.0.1:[0-9]+/\?token=[^ ]+' $ROOT/logs/remote-web.log
```

拿到 `<port>`/`<token>` 后本地：`ssh -N -L 127.0.0.1:<port>:127.0.0.1:<port> <主机别名>`，浏览器/curl 打开 `http://127.0.0.1:<port>/?token=<token>`（首次 303 到干净 URL 并种 cookie，之后不再需要 token）。

## 已知坑与规避

1. **必须用回环 authority**：cookie 名是 `dsh-auth-<base64url(sha256(Host))>` 且 `SameSite=Strict`；公网域名 / Tailscale IP / 非回环 IP 会 401/403。本地一律 `127.0.0.1`，不要混用 `localhost`。
2. **（历史）npm 11 install-scripts 门禁**：`npm install` 默认不跑依赖脚本；旧栈需要 `@deepseek-ai/dsh-subprocess-local` 的 postinstall（给 node-pty helper 补可执行位），`setup-remote.sh` 已直接执行；`node-pty`/`koffi` 随包带 prebuild，无需编译工具链。当前 npx 路径由 npm 负责包安装，不改这个门禁。
3. **（历史）长安装防 SIGHUP**：本地 SSH 瞬时断开会让远端 npm 安装被 SIGHUP 中断（文件已落盘），重跑幂等脚本即恢复。当前 npx 路径把进程放在 `setsid/nohup` 下，并从远端日志判断就绪。
4. **IPv6 链路抖动**：本地→VM 的 IPv6 偶发超时（`ssh: banner exchange`）。`remote.ps1` 对 ssh 有重试，仍建议隔几秒重试；仍不通先 `Test-NetConnection <主机地址> -Port 22`。
5. **空工作区**：远端 `~/.dsh/storages/workspace.json` 为空时，首屏弹「预览版说明」+「无法创建默认工作区」toast，composer 不出现；E2E 若要会话操作需先选工作区或预置 workspace。
6. **单实例**：同一 `DSH_HOME` 不要并发跑多个 web 进程；插件按注册表收养自己的进程，但不接管手工启动的实例。

## 证据文件（历史）

- `evidence/curl-check.result.json`：18 项 HTTP/cookie/API 栅栏/WS 检查（全 PASS）。
- `evidence/01-token-exchange.headers.txt`：303 + Set-Cookie（cookie 值已打码）。
- `evidence/02-authenticated.*`：二次访问 200 + HTML（含无 XFO/CSP 的证据头）。
- `evidence/03-unauthenticated.*`：401 对照。
- `evidence/04..12-*`：API Host/Origin/Sec-Fetch-Site 矩阵与 WS 101/403。
- `evidence/embed-check.result.json` + `embed-check.png`：V0 时代 puppeteer iframe 验证与截图（历史）。
- `evidence/handover-verification.txt`：停止验证 + `Host self` 自环 SSH 验证。
