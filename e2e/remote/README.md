# e2e/remote · 真实主机验收说明

> 当前插件不需要在本目录「自举」任何运行时：远端 DSH 由插件用托管 Node +
> `npx -y @deepseek-ai/dsh@<本机版本> --profile <profile> --no-open --port 0` 启动，
> `DSH_HOME` 就是远端用户真实的 `~/.dsh`，Node 自动装到 `~/.dsh/remote-go/node`（官方
> tarball + SHA-256，不碰系统 Node、不做隔离 home）。本文件只记录真实主机验收的步骤与坑。

## 前置条件

- 本地：DSH 桌面端（或 `dsh web`）+ 本插件；到测试主机的 SSH 免密可用。
- 远端：Linux、`curl` 或 `wget`；首次连接能访问 `nodejs.org`（或 `npmmirror.com`）与 npm registry；约 400 MB 可用磁盘。
  不要求预装 Node，也不需要 root。

## 验收步骤

1. 在本地 DSH 侧边栏主机条点「添加主机」，填地址或 `~/.ssh/config` 别名、用户名与私钥路径（或一次性密码）；可选跳板机。
2. 点「连接」：连接窗口上半是分阶段进度，下半是连接日志。首次连接在窗口里确认主机指纹（可「接受并记住」）。
3. 日志里应依次出现：SSH 目标与指纹 → 探测结果 → 托管 Node 下载/复用 → `npx` 预检回读版本 → 远端 DSH 启动（pid/port）→ 隧道两端端口 → 界面校验；随后自动闭合并接管整窗。
4. 点主机条里的「本地」可随时切回；SSH 与远端任务不受影响（按存活策略）。
5. 只读排障：远端 `~/.dsh/remote-go/logs/web.log` 是远端 `dsh web` 的 stdout/stderr；`run/web.json` 只记录 pid/port/version/profile/dshHome。

## 已知坑

1. **必须用回环 authority**：远端 cookie 名是 `dsh-auth-<base64url(sha256(Host))>` 且 `SameSite=Strict`，本地一律经 `127.0.0.1` 隧道访问；不要换成 `localhost`/公网域名。
2. **同一 `DSH_HOME` 不要并发跑多个 web**：插件按 run registry 收养自己的进程，不接管手工启动的实例；连接期间不要再手工起一个。
3. **空工作区首屏**：远端 `~/.dsh/storages/workspace.json` 为空时，首屏会弹预览说明/无法创建工作区的提示，composer 不出现；需要会话验收时先选工作区或预置 workspace。
4. **IPv6 抖动**：本地→VM 的 IPv6 偶发 `ssh: banner exchange` 超时，隔几秒重试；仍不通先 `Test-NetConnection <主机地址> -Port 22`。
5. **失败看连接日志**：托管 Node 下载、npx 取包、远端启动、隧道、界面校验的失败原因都逐行留在连接窗口与 `web.log`，不要只看最终错误卡片。

## 历史

0.1.0 早期的隔离运行时工具（`remote.ps1`、`setup-remote.sh`、`start-remote.sh`、`stop-remote.sh`、
`status-remote.sh`、`setup-self-ssh.sh`、`curl-check.ps1`、`collect-evidence.sh`、V0 的
`embed-check/` 与 `evidence/`）已被删除：它们指向 `~/.dsh-remote-go` 隔离运行时（0.2.2-rc.1），
当前插件从不读取或收养该目录，且其中记录了真实测试主机的地址。需要考古时从 git 历史取回。
