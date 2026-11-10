# e2e/remote · 远端测试环境自举与 V0 验证

本目录是 task-1 的交付：在腾讯云测试机（`tencent-vm`）上建立**与本地同版本**的隔离 DSH Web 运行时，并完成 V0 可行性验证（token→cookie→同站 loopback iframe）。实测结论与证据见 **[v0-report.md](v0-report.md)**。

## 当前交接状态（重要）

- 远端运行时**保留**：`/home/ubuntu/.dsh-remote-go/{node,dsh-home,home}`，版本 Node `v24.22.2` + `@deepseek-ai/dsh@0.2.2-rc.1`。
- V0 自己的 web 实例（pid 1374966 / 端口 45905）与本地隧道**已停止**，端口已不监听；`.token` 已删除。
- **`dsh web` 生命周期归 Lead 的插件 E2E**（T0-local 复用该运行时并自行启动/管理）。插件运行期间**不要**执行本目录的 `start-remote.sh` / `remote.ps1 start`，否则会争用同一个 `DSH_HOME`。
- 只读检查随时可用：`bash ~/.dsh-remote-go/scripts/status-remote.sh`（不会启动/停止任何进程，也不碰 `DSH_HOME`）。
- `.state.json` 记录了运行时路径、日志路径、启动/停止命令、最后一次 web 运行参数与交接说明。
- 远端 `~/.ssh/config` 已加 `Host self`（127.0.0.1 自环登录，供后续「嵌套一层」实验；见 `setup-self-ssh.sh`）。

## 目录与文件

| 文件 | 作用 |
|---|---|
| `setup-remote.sh` | 远端执行：下载/校验/解压 Node v24.22.2，npm 安装精确版本 dsh 到私有 prefix，验证版本。幂等。 |
| `start-remote.sh` | 远端执行：用隔离 `DSH_HOME` 以 `setsid+nohup` 启动 `dsh --profile web --no-open --port 0`，解析 `dsh web:` 行，写 `run/{web.pid,web.port,web.token,web.url,web.state.json}`。幂等（存活则复用，`RESTART=1` 强制重启）。 |
| `stop-remote.sh` | 远端执行：向进程组发 SIGTERM，等待/兜底 SIGKILL，清理 run 状态。幂等。 |
| `status-remote.sh` | 远端执行：**只读**检查运行时版本/磁盘/目录/记录态与「当前有哪些进程在用这个运行时」以及监听端口。 |
| `collect-evidence.sh` | 远端执行：V0 证据采集（进程/环境/日志/目录/计时探针），输出到 `evidence/remote-evidence.txt`。 |
| `setup-self-ssh.sh` | 远端执行：可选，添加 `Host self` 自环 SSH 别名（幂等）。 |
| `remote.ps1` | Windows 本地驱动：上传脚本（base64+md5 校验）、执行 setup/start/status/stop、管理 `ssh -N -L` 隧道、写 `.state.json`。 |
| `curl-check.ps1` | 本地：经隧道跑 B 段全部 curl 检查，写 `evidence/*.headers.txt` 与 `evidence/curl-check.result.json`（token/cookie 值自动打码）。 |
| `embed-check/` | 本地：`puppeteer-core` + 本机 Chrome 的 iframe 验证（独立 `package.json`，不碰根 `package.json`）。 |
| `evidence/` | 所有实测证据（头信息、结果 JSON、截图、采集文本）。 |
| `v0-report.md` | 结论报告（预期/实测/证据/结论）。 |
| `.state.json` | 运行/交接状态（**不含 token**）。 |

## 前置条件

- 本地：Windows + PowerShell 7（`pwsh`）；`ssh tencent-vm` 免密可用；Chrome 或 Edge。
- 打包运行时（本地无 PATH node/npm/pnpm 时）：
  - node：`C:\Users\zhang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
  - pnpm：`...\pnpm\bin\pnpm.mjs`
  - 本文命令默认使用这两个路径；其他机器可用 `DSH_NODE` / `DSH_PNPM` 覆盖。
- 远端：Ubuntu 24.04、`curl/tar/xz/sha256sum/setsid/nohup/ss/pgrep/base64` 可用（本次已确认）；能访问 nodejs.org 与 npm registry（本次 npm 走腾讯云镜像，亦可）。

## 复跑步骤

所有命令在仓库根目录执行。

### 1) 远端自举（幂等，已装则秒级跳过）

```powershell
pwsh -File e2e/remote/remote.ps1 setup
```

等价的手工方式（在远端执行）：

```bash
bash ~/.dsh-remote-go/scripts/setup-remote.sh
# 期望结尾：SETUP_OK + DSH_VERSION=0.2.2-rc.1
```

### 2) 启动远端 web + 本地隧道

```powershell
pwsh -File e2e/remote/remote.ps1 start
```

它会：启动远端 web（`--port 0`，OS 分配端口）→ 解析 `dsh web: http://127.0.0.1:<port>/?token=...` → 把 token 写入远端 0600 文件后取回本地 `.token` → 起 `ssh -N -L` 隧道 → 写 `.state.json`。

> 注意：`ssh -N` 隧道是长生命周期子进程，在被 agent 工具前台调用时可能因「仍有子进程」而不返回（本次实测会被转后台）。手动复跑建议单独开一个终端执行 `remote.ps1 start`，或用 `remote.ps1 tunnel-start` 单独维持隧道；`.state.json` 写好后即可继续。

期望关键输出：`REUSED=0`、`PORT=<port>`、`STARTUP_SECONDS≈6`、`REMOTE_PROBE_HTTP=401`、`tunnel up ... probe 401`。

### 3) token/cookie/HTTP 证据（B 段）

```powershell
pwsh -File e2e/remote/curl-check.ps1    # 期望 summary: 18/18 passed
```

输出：`evidence/curl-check.result.json`、`evidence/01-*.headers.txt` … `evidence/13-*`。

### 4) iframe 同站嵌入验证（C 段）

```powershell
pwsh -File e2e/remote/embed-check/run-check.ps1
```

首次会自动 `pnpm install`（只装 puppeteer-core，不下载浏览器），读取 `.state.json` 的远端端口与 `.token`，用本机 Chrome 打开一个本地包装页并嵌入 `http://127.0.0.1:<port>/?token=...`。
期望：`embed-check: verdict=pass checks=11/11`，输出 `evidence/embed-check.result.json` 与 `evidence/embed-check.png`。

可用参数：`-Chrome <path>`（默认 `C:\Users\zhang\scoop\shims\chrome.exe`）、`-RemotePort`、`-TokenFile`、`-TimeoutMs`。

### 5) 状态检查（只读，插件运行期间也可安全执行）

```powershell
pwsh -File e2e/remote/remote.ps1 status
```

远端直接执行：`bash ~/.dsh-remote-go/scripts/status-remote.sh`。它会列出运行时版本、`RUNTIME_WEB_PROCESS_COUNT`、各进程 PID/端口/监听、`DSH_HOME` 目录树、日志尾部（token 打码）。

### 6) 停止（V0 自管模式；交接给插件后不要用）

```powershell
pwsh -File e2e/remote/remote.ps1 stop
```

停止远端进程组 + 本地隧道，清理远端 `run/` 与本地 `.token`，`.state.json` 标记 `status=stopped`。

## 手工调试：自起一个 web 并拿端口/token

```bash
ROOT=$HOME/.dsh-remote-go
$ROOT/node/bin/node $ROOT/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js --version   # 0.2.2-rc.1
DSH_HOME=$ROOT/home setsid nohup $ROOT/node/bin/node \
  $ROOT/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --port 0 \
  >> $ROOT/logs/remote-web.log 2>&1 &
# 轮询日志：
grep -Eo 'dsh web: http://127.0.0.1:[0-9]+/\?token=[^ ]+' $ROOT/logs/remote-web.log
```

拿到 `<port>`/`<token>` 后本地：`ssh -N -L 127.0.0.1:<port>:127.0.0.1:<port> tencent-vm`，浏览器/curl 打开 `http://127.0.0.1:<port>/?token=<token>`（首次会 303 到干净 URL 并种 cookie，之后不再需要 token）。

## 已知坑与规避

1. **必须用回环 authority**：cookie 名是 `dsh-auth-<base64url(sha256(Host))>` 且 `SameSite=Strict`；跨 site 地址（公网域名 / Tailscale IP / 非回环 IP）会 401/403 且 iframe 发不出 cookie。本地一律 `127.0.0.1`，不要混用 `localhost`。
2. **npm 11 的 install-scripts 门禁**：`npm install` 默认不跑依赖安装脚本；本栈真正需要的是 `@deepseek-ai/dsh-subprocess-local` 的 postinstall（给 node-pty 的 helper 补可执行位），`setup-remote.sh` 已直接执行该幂等脚本；`node-pty`/`koffi` 的原生模块随包自带 prebuild，无需编译工具链。
3. **长安装步骤防 SIGHUP**：本次首次 npm 安装即因本地 SSH 瞬时断开被 SIGHUP 中断（文件已落盘）。重跑幂等脚本即恢复；插件实现建议把长安装放 `setsid/nohup`，用远端完成标记判断成功。
4. **IPv6 链路抖动**：本地→VM 的 IPv6 偶发超时（`ssh: banner exchange` 超时）。`remote.ps1` 对 ssh 调用有重试，但仍建议失败后隔几秒重试；仍不通时先 `Test-NetConnection 240d:c000:f05f:8d00:327e:8b66:5c18:0 -Port 22`。
5. **空工作区**：远端 `home/storages/workspace.json` 为空时，首屏会弹「预览版说明」+「无法创建默认工作区」toast，composer 不出现；E2E 若要会话操作需先选工作区或预置 workspace。
6. **单实例**：同一 `DSH_HOME` 不要并发跑多个 web 进程；交接后由插件独占。

## 证据文件

- `evidence/curl-check.result.json`：18 项 HTTP/cookie/API 栅栏/WS 检查（全 PASS）。
- `evidence/01-token-exchange.headers.txt`：303 + Set-Cookie（cookie 值已打码）。
- `evidence/02-authenticated.*`：二次访问 200 + HTML（含无 XFO/CSP 的证据头）。
- `evidence/03-unauthenticated.*`：401 对照。
- `evidence/04..12-*`：API Host/Origin/Sec-Fetch-Site 矩阵与 WS 101/403。
- `evidence/embed-check.result.json` + `embed-check.png`：puppeteer iframe 11/11 PASS 与截图。
- `evidence/remote-evidence.txt`：进程/环境/日志/DSH_HOME/启动计时探针。
- `evidence/handover-verification.txt`：停止验证 + `Host self` 自环 SSH 验证。
