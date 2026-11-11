# V0 可行性验证报告（远端自举 + token/cookie + 同站 loopback iframe）

- 验证时间：2026-11-11 00:00–00:32（Asia/Shanghai；远端 UTC+0）
- 测试主机：腾讯云 VM，Ubuntu 24.04 x86_64，用户 `ubuntu`，IPv6 `<已脱敏>`（本地 SSH 别名 `<host-alias>`；IPv4 回程不可用，全程走 IPv6）
- 本地：Windows 11，DSH 0.2.2-rc.1，Chromium/Chrome 157.0.8103.39
- 远端隔离根目录：`/home/ubuntu/.dsh-remote-go`（与旧 `~/.dsh` 完全隔离，未触碰）
- 任务：task-1（owner `remote-env`）

## 总体结论

**V0 通过。** 在「远端 DSH 只绑 `127.0.0.1` + 本地 `ssh -L` 映射到 `127.0.0.1`」的前提下：

1. token→cookie 兑换可用（303 + `HttpOnly; SameSite=Strict` 的 `dsh-auth-*` cookie，按 authority 绑定）；
2. 二次访问返回 200 与真实前端 HTML，**响应头没有 `X-Frame-Options`，也没有 CSP `frame-ancestors`**；
3. 真实 Chrome 中，来自 `http://127.0.0.1:<另一个端口>` 的**同站（same-site）不同源 iframe 可以完整加载远端 DSH UI**：DOM 渲染 1098 个节点、WebSocket `ws://127.0.0.1:<port>/api/remote.mux` 握手 101 且有双向帧、无 console/page error、无失败请求；
4. 因此**不需要同源 portal 反代**即可实现「整页嵌入远端 DSH」的 V0 形态。前提是必须保持回环 authority（`127.0.0.1:<port>`），跨 site 地址（公网域名 / Tailscale IP / 非回环 IP）仍然嵌不进来（服务端 Host/Origin/sec-fetch-site 栅栏 + 浏览器 SameSite=Strict 双重限制）。

> 证据文件全部在 `e2e/remote/evidence/`，本报告只引用摘要；token 只保留前缀 `hXGRV0` 与长度 43，cookie 值、token 值均已打码。

---

## A. 远端自举（T3 路径：自带 Node + 精确版本 npm 安装）

### A1. 做法

脚本：`e2e/remote/setup-remote.sh`（远端执行，幂等；本地驱动 `remote.ps1 setup` 负责上传并调用）。
隔离目录布局：

```
~/.dsh-remote-go/
├── node/                              # 官方 Node v24.22.2 linux-x64（sha256 校验后解压）
├── node-v24.22.2-linux-x64.tar.xz     # 31 MB 下载缓存
├── SHASUMS256.txt                     # 3.1 KB
├── dsh-home/                          # npm --prefix 私有安装根（920 MB）
│   ├── package.json / package-lock.json
│   └── node_modules/@deepseek-ai/dsh  # 0.2.2-rc.1
├── home/                              # 隔离 DSH_HOME（44 KB）
├── logs/  setup.log  remote-web.log
├── run/   install.json（+ 现行 web 运行态由插件维护）
└── scripts/ setup/start/stop/status/collect-evidence/setup-self-ssh
```

关键命令（脚本内固定，可重跑）：

```bash
# 1) Node 官方包 + 同目录 SHASUMS256.txt 校验
curl -fsSL -o SHASUMS256.txt https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
curl -fsSL -o node-v24.22.2-linux-x64.tar.xz https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz
expected=$(awk '$2=="node-v24.22.2-linux-x64.tar.xz"{print $1}' SHASUMS256.txt)
actual=$(sha256sum node-v24.22.2-linux-x64.tar.xz | awk '{print $1}')
[ "$actual" = "$expected" ]   # 实测通过
tar -xJf node-v24.22.2-linux-x64.tar.xz --strip-components=1 -C ~/.dsh-remote-go/node

# 2) 精确版本、私有 prefix、不全局安装
PATH=~/.dsh-remote-go/node/bin:$PATH npm install \
  --prefix ~/.dsh-remote-go/dsh-home @deepseek-ai/dsh@0.2.2-rc.1

# 3) 版本验证
~/.dsh-remote-go/node/bin/node \
  ~/.dsh-remote-go/dsh-home/node_modules/@deepseek-ai/dsh/lib/bin.js --version
# => 0.2.2-rc.1
```

### A2. 实测结果

| 项 | 预期 | 实测 | 结论 |
|---|---|---|---|
| Node 版本 | v24.22.2（DSH 要求 >=24.9） | `v24.22.2` | 通过 |
| Node tarball sha256 | 与 SHASUMS256.txt 一致 | `48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75` 一致 | 通过 |
| npm 版本 | 自带 | `11.19.1` | — |
| dsh 安装方式 | 精确 0.2.2-rc.1、私有 prefix、非全局 | `~/.dsh-remote-go/dsh-home/node_modules/@deepseek-ai/dsh` 0.2.2-rc.1 | 通过 |
| 版本验证 | 输出 `0.2.2-rc.1` | `0.2.2-rc.1` | 通过 |
| 幂等重跑 | 第二次跳过下载/安装，1 秒完成 | `node ... already installed (skip)` / `dsh@... already installed (skip)` / `SETUP_OK` | 通过 |
| 磁盘占用 | 用户目录内，无需 root | node 208 MB + dsh-home 920 MB + home 44 KB ≈ 1.13 GB | 通过 |

`run/install.json`（自动生成）：

```json
{
  "root": "/home/ubuntu/.dsh-remote-go",
  "nodeVersion": "v24.22.2",
  "npmVersion": "11.19.1",
  "dshVersion": "0.2.2-rc.1",
  "installedAt": "2026-11-10T16:16:24Z",
  "installedSizeKb": 1153824
}
```

### A3. 自举踩坑（对插件 T3 实现的输入）

1. **npm 11.19 的 install-scripts 门禁**：`npm install` 会把 5 个依赖标成 `install-scripts not yet covered by allowScripts` 并默认不执行脚本（`@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`、`@google/genai`、`protobufjs`）。
   - 实测 `node -pty`、`koffi` 未执行脚本也能 `require()` 成功（原生 `.node` 随包自带 prebuild）；真正需要的只有 `@deepseek-ai/dsh-subprocess-local` 的 postinstall —— 它只是给 node-pty 的 `spawn-helper` 补可执行位。
   - `setup-remote.sh` 已直接执行该幂等 postinstall 内容（`ensure-spawn-helper.mjs`），**不**全局 approve 所有脚本（安全）。
   - 对插件的启示：T3 安装器要么显式执行这一个 postinstall，要么接受 `allow-scripts` 交互；不要盲目 `--dangerously-allow-all-scripts`。
2. **SSH 断连会 SIGHUP 杀掉 setup**：第一次 `npm install` 已完成（package.json / package-lock 已落盘、版本可查），但本地 SSH 瞬时断开导致 setup 脚本被 SIGHUP 终止，未打印 `SETUP_OK`。重跑幂等脚本 1 秒内补齐并 `SETUP_OK`。
   - 对插件的启示：长安装步骤应在远端 `setsid/nohup` 下执行并轮询完成标记（本次 V0 脚本未做，记为改进项）；本地重连后以「版本验证」而非退出码判断安装完成。
3. 网络：本地到 VM 的 IPv6 链路存在间歇性丢包/超时（`ssh: banner exchange` 偶发超时），脚本与驱动均加重试；不影响结论。

---

## B. 隧道 + token/cookie 实测（curl）

本地隧道：`ssh -N -L 127.0.0.1:<port>:127.0.0.1:<port> <host-alias>`（后台，`-o ExitOnForwardFailure=yes`），隧道本地端口复用远端端口 `45905`，因此 `Host` 与远端 URL authority 完全一致（都是 `127.0.0.1:45905`）。
报告正文中的端口 `45905` 来自本次 V0 实例（`--port 0` 由 OS 选择）；token 前 6 位 `hXGRV0`、长度 43。

### B1. 用 token 兑换 cookie：`GET /?token=<TOKEN>`

实测：**HTTP 303 See Other**，`Location: ./`，`Set-Cookie` 原文（cookie 值已打码）：

```
HTTP/1.1 303 See Other
cache-control: no-store
location: ./
referrer-policy: no-referrer
set-cookie: dsh-auth-R9GyCGpCVKhIX21mIzyzdvw9Fc9JoqhxKoMBHCYvmy0=<REDACTED>; Max-Age=2592000; Path=/; Expires=Thu, 10 Dec 2026 16:25:59 GMT; HttpOnly; SameSite=Strict
```

| 项 | 预期 | 实测 | 结论 |
|---|---|---|---|
| 状态码 | 303 | 303 | 通过 |
| Location | `./`（去掉 token 的干净目录） | `./` | 通过 |
| cookie 名 | `dsh-auth-<base64url(sha256(authority))>` | `dsh-auth-R9GyCGpCVKhIX21mIzyzdvw9Fc9JoqhxKoMBHCYvmy0` | 通过 |
| 属性 | `HttpOnly; SameSite=Strict; Path=/` | 完全一致；HTTP 下**无 Secure** | 通过 |
| 有效期 | 有 Max-Age/Expires | `Max-Age=2592000`（30 天） | — |

源码佐证（远端安装包 `@deepseek-ai/dsh-client-connection/lib/index.js`，读自 `dsh-home/node_modules`）：

```js
const COOKIE_PREFIX = "dsh-auth-";
function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());
}
const attributes = `${name}=${value}; Max-Age=${...}; Path=/; Expires=${...}; HttpOnly; SameSite=Strict`;
return secure ? `${attributes}; Secure` : attributes;
```

`authority` 取自请求 `Host`（HTTP 下是 `host(:port)`），所以 cookie **按 authority 绑定**——换端口/换主机名都会得到不同 cookie 名，这是「必须走 127.0.0.1 隧道」的根因之一。

### B2. 带 cookie 二次访问 `GET /`（先清 token）

实测：**HTTP 200**，`content-type: text/html; charset=utf-8`，HTML 40102 字节，`<title>DeepSeek Harness</title>`。响应头原文：

```
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
Vary: Accept-Encoding
Date: Tue, 10 Nov 2026 16:26:00 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked
```

| 项 | 预期 | 实测 | 结论 |
|---|---|---|---|
| 状态 | 200 | 200 | 通过 |
| 内容 | HTML 前端 | `text/html`，40102 B，title `DeepSeek Harness` | 通过 |
| `X-Frame-Options` | 若存在则 iframe 可能被禁 | **不存在** | 可嵌入 |
| `Content-Security-Policy` | 若含 `frame-ancestors` 则受限 | **不存在** | 可嵌入 |

> 结论：DSH 0.2.2-rc.1 的 index/静态资源响应没有 XFO/CSP frame 限制，嵌入侧无需反代即可做 iframe。

### B3. 不带 cookie 访问 `GET /`（对照）

实测：**HTTP 401 Unauthorized**，`cache-control: no-store`，`content-type: text/plain; charset=utf-8`。

| 项 | 预期 | 实测 | 结论 |
|---|---|---|---|
| 状态 | 401 | 401 | 通过 |

### B4. API 信任栅栏（Host / Origin / Sec-Fetch-Site）——iframe 为什么能行

对 `POST /api/session/list`（合法 RPC 路径）用 curl 做矩阵（请求体是故意最简 JSON，`ok=false` 但栅栏结论只看状态码）：

| 用例 | 预期 | 实测 |
|---|---|---|
| 带 cookie | 200 | **200** |
| 不带 cookie | 401 | **401** |
| `Origin: http://127.0.0.1:45905`（同 authority） | 200 | **200** |
| `Origin: http://evil.example` | 403 | **403** |
| `Host: evil.example`（DNS rebinding 防护） | 403 | **403** |
| `Sec-Fetch-Site: cross-site` | 403 | **403** |
| `Sec-Fetch-Site: same-site` | 200 | **200** |

WebSocket（浏览器真实使用的 `/api/remote.mux`）：

```
GET /api/remote.mux  (Cookie + Upgrade: websocket)
=> HTTP/1.1 101 Switching Protocols
   Upgrade: websocket
   Connection: Upgrade
   Sec-WebSocket-Accept: ...
带 Origin: http://evil.example 时 => HTTP/1.1 403 Forbidden
```

源码佐证（`dsh-client-connection/lib/index.js`）：

```js
if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(...) && !isBindAddressAuthority(...)) return false;
if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
const origin = header(request.headers, "origin");
if (origin === undefined) return true;
return isSameAuthorityOrigin(origin, host);
```

**关键结论**：`/api/*` 要求 Host 为回环（或显式 trustedHosts）、`Origin` 同 authority、且拒绝 `Sec-Fetch-Site: cross-site`；index/静态页只校验 authority-bound cookie。浏览器从 `http://127.0.0.1:<另一端口>` 的页面嵌 `http://127.0.0.1:<DSH端口>` 属于 **same-site（scheme+host 相同，端口不同）**，因此：
- `Sec-Fetch-Site` 是 `same-site` 而非 `cross-site`，API 栅栏放行；
- `SameSite=Strict` 的 cookie 在 same-site iframe 中仍会发送；
- 反过来，跨 site 场景（公网域名/Tailscale IP）必然失败——与本项目「回环硬规则」一致。

---

## C. V0 iframe 同站嵌入验证（真实浏览器，puppeteer-core）

工具：`puppeteer-core@25.17.0`（不下载浏览器）+ 本机 Chrome/Edge（Chrome 157.0.8103.39），无头模式 1440×900。
包装页：本地 node http server（随机端口），内容只有 `<iframe src="http://127.0.0.1:45905/?token=<TOKEN>">`；包装页地址 `http://127.0.0.1:58420/`（与远端 same-site、不同 origin，正是插件的实际嵌入形态）。
脚本：`e2e/remote/embed-check/embed-check.mjs`；结果：`e2e/remote/evidence/embed-check.result.json`；截图：`e2e/remote/evidence/embed-check.png`。

### C1. 结果：11/11 检查通过（verdict=pass）

| 检查 | 预期 | 实测 | 结论 |
|---|---|---|---|
| frame.found | iframe 中存在 `127.0.0.1:45905` 的 frame | `http://127.0.0.1:45905/` | 通过 |
| frame.cookie-exchange | 首次带 token 后 303 到干净 `/`（URL 不含 token） | frame URL = `http://127.0.0.1:45905/` | 通过 |
| frame.dom-rendered | 远端 DOM 真实渲染 | 1098 个元素，`document.readyState=complete`，12 个 script | 通过 |
| frame.no-error-text | 无登录/401/错误页文案 | body 前 200 字：`新会话 Ctrl + Alt + N 插件 自动化任务 更多 工作区 暂无会话 更多 探索未至之境 预览版 选择工作区 选择一个工作区开始` | 通过 |
| cookie.dsh-auth-present | iframe 上下文出现 `dsh-auth-*` cookie | `dsh-auth-R9GyCGpCVKhIX21mIzyzdvw9Fc9JoqhxKoMBHCYvmy0`，domain=`127.0.0.1`，httpOnly=**true**，sameSite=**Strict**，secure=false | 通过（token 兑换的硬证据） |
| websocket.created | 连上远端 WS | `ws://127.0.0.1:45905/api/remote.mux`（1 个） | 通过 |
| websocket.101 | 握手 101 | status=101 | 通过 |
| websocket.traffic | WS 有双向业务帧 | received=5, sent=5 | 通过 |
| console.no-fatal | 无未捕获异常 | 0 pageerror | 通过 |
| network.no-failed-remote-requests | 无失败远端请求 | 0 | 通过 |
| wrapper.loaded | 包装页 200 | 200 | 通过 |

`frame.title = "DeepSeek Harness"`，`sidebarPresent=true`。

### C2. 需要向后续 E2E 说明的两个 UI 状态

1. **首次进入是「预览版说明」弹窗 + Toast「无法创建默认工作区，请通过“选择工作区”选择文件夹」**：远端 `DSH_HOME` 的 `storages/workspace.json` 为空（没有工作区）。因此首屏 `composerInputPresent=false`（输入框要选好工作区后才出现），但 UI/DOM/WS 均已真实工作。
   - 若 E2E 需要 composer/会话操作，应先通过 UI 选一次工作区，或预先向远端 `~/.dsh-remote-go/home/storages/workspace.json` 写入工作区配置（本次未预置，保持原样交付）。
2. 截图 `evidence/embed-check.png` 可直观看到 iframe 内完整的 DSH 界面（侧栏「新会话/插件/自动化任务/工作区」、预览版说明弹窗、右上角 toast）。

### C3. 结论

**同站 loopback iframe 可直接嵌入，无需同源反代。** iframe 内的 DSH 完成 token→cookie、加载前端、建立 `/api/remote.mux` WebSocket 并收到业务帧；无 XFO/CSP 阻断，无跨站 cookie 问题。后续实现只需保证：

- 远端只绑 `127.0.0.1`，本地 `ssh -L 127.0.0.1:<本地端口>:127.0.0.1:<远端端口>`；
- iframe 的源与目标同为回环（recommended：都用 `127.0.0.1`，端口任意不同；**不要**混用 `localhost` 与 `127.0.0.1`，authority 不同会导致 cookie 不匹配）；
- 首次加载用 `?token=<launchToken>`，之后让页面 303 到干净 URL；
- 不添加会破坏嵌入的 `X-Frame-Options`/CSP（本地包装页不受 DSH 控制；DSH 侧本身没有）。

---

## D. 给 Lead / 插件实现的额外实测信息

### D1. 启动耗时

- 首次启动（真实首启，从进程创建到日志出现 `dsh web:` 行）：**约 6 秒**（`pid` 创建 00:16:49 → URL 就绪 00:16:55.7）。
- 隔离计时探针（全新 `DSH_HOME`、复用同一个 node/dsh 运行时、走正式 `start-remote.sh` 路径）：`STARTUP_SECONDS=6`，端口 33033，`curl /` 得 401，停止后端口 0。
- 结论：冷启动约 5–7 秒；远端 `--profile web` 在空 `DSH_HOME` 下**可以自动初始化**，无需额外参数（首次会生成 `profiles/web/` 等，见 D4）。

### D2. `launchedThroughSsh`（SSH 环境检测）与桌面功能抑制

- 通过 SSH 会话启动时，进程环境继承 `SSH_CONNECTION`（实测 `SSH_CONNECTION=240e:304:...:22`，`SSH_TTY` 未设置），`DSH_HOME` 为隔离目录。
- 源码（`@deepseek-ai/dsh-launch-environment/lib/index.js`）：

```js
function launchedThroughSsh(environment) {
  return ["SSH_CONNECTION", "SSH_TTY"].some((name) => {
    const value = environment.getFrom(name, ["process"])?.value;
    return value !== void 0 && value !== "";
  });
}
```

- `@deepseek-ai/dsh-web-app/lib/index.js`：`handoffBrowser = config.openBrowser && !launchedThroughSsh(...)`。本次启动显式 `--no-open`，且 SSH 环境检测为 true，因此**不会在远端弹出浏览器**；日志中也没有 `dsh web: opening the default browser`。
- 对插件的启示：从 SSH 会话拉起远端 web（或显式注入 `SSH_CONNECTION` 标记），可避免远端桌面交互被误触发；这是设计文档 P5 的实测确认。

### D3. 进程管理与「断开 SSH 后存活」

- 启动方式：`setsid env DSH_HOME=... bash -c 'echo $$ > pidfile; exec node ...' ... &`，随后 `disown`。实测进程属性：

```
PID 1374966  PPID=1  PGID=1374966  SID=1374966  STAT=Ssl  RSS=338400KB
```

  即 `setsid` 后成为独立会话/进程组首领，父进程是 init（1），**不随 SSH 会话结束**。
- 存活验证：该实例于 00:16:49 启动，至停止前 `ETIMES=738s`；期间本地 SSH 连接反复建立/断开（含一次 setup 被 SIGHUP 杀掉），**web 进程始终存活并持续服务**（多次 curl 200/401、puppeteer 访问均成功）。这是「关闭本机/断开 SSH 后远端继续运行」策略（设计 §16.4）的直接证据。
- 停止方式（`stop-remote.sh`）：读 pidfile → `SIGTERM` 整个进程组 → 等待 ≤20s → 必要时 `SIGKILL` 兜底 → 清理 `run/` 状态。实测：**SIGTERM 即退出，无 SIGKILL 升级**（`SIGKILL_ESCALATED=0`），停止后端口探测 `000`（连接被拒），pid 不存在。
- 日志与状态文件权限：`remote-web.log` / `web.pid` / `web.token` / `web.url` 均为 **0600**（脚本 `umask 077`）；token 只在远端 0600 文件与日志中出现，未写入本报告。

### D4. 远端隔离 `DSH_HOME`（`~/.dsh-remote-go/home`）生成内容

```
home/
├── .anonymous-user-id
├── .credentials.yaml          # 0600，含浏览器 cookie 签名 secret，勿外泄
├── profiles/web/
│   ├── cordis.patch.yml
│   ├── cordis.yml
│   ├── package.json
│   └── pnpm-workspace.yaml
└── storages/workspace.json    # 当前为空（无工作区，导致首屏 toast）
```

- `--profile web` 在空 `DSH_HOME` 下自动创建 `profiles/web`（shipped profile 的用户层），不需要手工 `--from-default-profile`。
- 同一 `DSH_HOME` **不要并发跑多个 web 进程**（会话/存储共享写入）；插件接管后应保证单实例（本次 V0 已停止自己的实例，见交接）。

### D5. 附加：远端 loopback SSH 别名（供后续「远端里再嵌一层」实验）

按 Lead 要求，在远端 `~/.ssh` 加了自环登录（幂等脚本 `e2e/remote/setup-self-ssh.sh`）：

- 生成/复用 `~/.ssh/id_ed25519`，公钥写入 `~/.ssh/authorized_keys`；
- `~/.ssh/config` 追加：

```
# dsh-remote-go: nested self-SSH alias (loopback login for nested-embed tests)
Host self
    HostName 127.0.0.1
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking accept-new
```

- 实测：`ssh self '...'` → `SELF_OK host=VM-0-5-ubuntu user=ubuntu ssh_connection=127.0.0.1 43926 127.0.0.1 22`（sshd 在 0.0.0.0/[::]:22 监听）。
- 该操作未触碰 `~/.dsh-remote-go` 与任何 DSH 进程。

### D6. 交接状态（本报告完成时）

- **本地已停止** V0 的远端 web 实例（pid 1374966，端口 45905），并停止本地 ssh 隧道（pid 16424）；远端 `45905` 已不监听，`kill -0 1374966` 失败。
- **保留** `~/.dsh-remote-go` 运行时（node + dsh-home + home），供插件以 T0-local 复用；运行时状态用 `bash ~/.dsh-remote-go/scripts/status-remote.sh` 只读检查。
- 停止后观察到 Lead 的插件 E2E 已用该运行时启动了自己的 web 进程（快照：pid 1380785，端口 39025，`--profile web --no-open --port 0`）——说明 T0-local 复用路径可用；**不要**再运行 `start-remote.sh`，避免与插件争用同一 `DSH_HOME`。
- 本机 `.state.json` 已更新为 `status: stopped` + 运行时/日志/启动命令/交接说明；`.token` 已删除（token 随进程失效）。
- 远端 `/home/ubuntu/.dsh`（旧实验）全程未被读写/修改。

---

## E. 对 V0-1～V0-5 验收清单的回填

| 编号 | 验证项 | 本次结果 |
|---|---|---|
| V0-1 | 最小全局面板 iframe 指向本地回环隧道 | **通过**（本报告 C 段：真实 Chrome，同站 iframe 完整渲染） |
| V0-2 | cookie 种入：首次带 token 的 seedUrl，无 401、后续不带 token 可加载 | **通过**（B1/B2：303→cookie→200） |
| V0-3 | 持久化：刷新/关闭重开仍能进入 | **部分验证**：cookie `Max-Age=30 天`、HttpOnly；puppeteer 单次加载已验证。浏览器重启后的持久化未单独测（由 Lead 的插件 E2E 覆盖） |
| V0-4 | 失败降级「在新窗口打开」 | 未覆盖（属实现层，非 V0 闸门） |
| V0-5 | 断线恢复 30 秒 | 未覆盖（属实现层；WS 断开重连由 DSH 前端自己处理） |

## F. 复跑与证据索引

- `e2e/remote/README.md`：远端自举 / 启动 / 隧道 / curl / iframe 全流程复跑步骤。
- `e2e/remote/evidence/curl-check.result.json`：B 段 18 项检查（全 PASS）与头信息。
- `e2e/remote/evidence/embed-check.result.json` + `embed-check.png`：C 段 iframe 实测与截图。
- `e2e/remote/evidence/remote-evidence.txt`：非交互采集（进程/环境/日志/目录/计时探针）。
- `e2e/remote/evidence/handover-verification.txt`：停止验证 + self-SSH 验证。
- `e2e/remote/.state.json`：当前运行时与交接状态（无 token）。
