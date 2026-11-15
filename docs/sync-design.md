# 本地 → 远端同步（v1）

> 本文是同步功能的设计与实现约定：同步什么、怎么合并、失败怎么退。API 契约见 [api.md](api.md)，
> 模块划分见 [implementation.md](implementation.md)。

## 1. 目标

连接一台远端主机时，把**本机正在使用的 DSH 组合**带到远端：同一批插件、同一套可移植配置、同一组
API key 与登录记录。用户不需要在远端再装一遍、再填一遍。

- 开关在**添加 / 编辑主机**的高级选项里，逐主机生效，默认关闭。
- 两个勾选：
  - **同步 API key / 登录状态**：写远端 `~/.dsh/.credentials.yaml` 的 `refs` 与 `records`。
  - **同步插件与插件配置**：按本机版本安装 registry 插件，并把它们的可移植配置行与本机
    provider / model 行写进远端 profile。
- 勾选后**每次连接**都会检查一次：计划哈希与远端记录一致就跳过，不一致才应用；管理清单里也可以
  手动重新同步（停止远端 → 同步 → 重新启动）。

## 2. 非目标

- 不做远端 → 本地反向同步，不做会话、工作区、附件、缓存与插件运行状态的迁移。
- 不复制 `node_modules`：插件一律在远端从 registry 按精确版本安装。
- 不自动改写 MCP `insert` 行、带本机绝对路径的行、平台专用插件；它们被**跳过并给出理由**。
- 不接管用户的远端手工配置：远端独有的插件、配置行、凭据默认保留。

## 3. 同步口径

| 对象 | 写到哪里 | 合并规则 |
|---|---|---|
| 插件 | 远端 `profiles/<profile>/package.json` 的 `dependencies` / `dsh.profile.bundles` | 由 `dsh plugin --profile <p> add <name>@<version>` 安装并选中；远端已是同一版本则保持 |
| 配置行 | 远端 `profiles/<profile>/cordis.patch.yml` | 同 `id` **整行替换**，其余**追加**；`insert` 行、本机路径行跳过 |
| API key | 远端 `~/.dsh/.credentials.yaml` 的 `refs` | 同名**本地覆盖**（这正是同步的意义）；远端独有的 key 保留 |
| 登录记录 | 同上 `records` | **只增不改**：同名记录保留远端；`client-connection/*` 永不复制 |
| 远端状态 | `~/.dsh/remote-go/sync/state.json` | 记录计划哈希、时间、计数与失败插件；哈希一致时下次连接跳过 |

读取本机一侧时：

- profile 取自运行中的 DSH（`DSH_PROFILE_DIR`），而不是用户手动选的 profile；远端 profile 仍取
  设置 `bootstrap.profile`（默认 `web`，拒绝 `desktop`）。
- 凭据值来自本机 `~/.dsh/.credentials.yaml`；只有引用存在、文件里却没有值时才回退到本机进程环境，
  避免把无关的环境变量带过去。

## 4. 可同步判定

| 类别 | 规则 |
|---|---|
| 插件 | 只接受 registry spec（版本/范围/tag）；`link:` / `file:` / git / `npm:` 别名跳过；`@deepseek-ai/*` 内置包跳过；`dsh-remote-go`、`dsh-windows-mcp` 固定跳过 |
| 平台 | 声明的 `os` 不含 `linux`、`cpu` 不含远端架构时跳过；`engines.dsh` / `engines.node` 不满足远端版本时跳过 |
| 构建脚本 | 声明 `preinstall` / `install` / `postinstall` 时照常尝试，但在计划里给出警告（pnpm 可能拦截） |
| 配置行 | 选中条件：插件归属（`name` 是被同步插件）、引用了被同步的凭据（含 `apiKeyEnv`），或 `agent-default-model`（key 的消费者） |
| 配置行（拒绝） | `insert` 行、值里出现盘符路径 / `.exe` / `pythonw` / `\\wsl` 的行 |
| 凭据 | `refs` 全部同步（空值跳过）；`records` 排除 `client-connection/*` 与结构不合法的记录 |

「跳过」不是静默：计划摘要按原因计数，连接日志逐条打印 `sync: skip … (reason)`。

## 5. 执行流程

```text
connect: ssh → probe → managed node → [sync prepare] → adopt / conflict →
         npx preflight → [sync apply] → start → tunnel → verify
```

- **prepare**：读本机快照 + 远端快照 → `planSync` → 计划哈希。失败只记一条 warning，连接继续。
- **adopt 判定**：远端已有受管实例时，比较实例启动时记录的哈希；不一致、从未同步或用户强制同步时
  先停掉再走 start，避免旧组合继续服务。
- **apply**：
  1. `tar` 备份 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、
     `.credentials.yaml` 到 `~/.dsh/remote-go/sync/backup-<ts>.tgz`；
  2. 合并凭据并写入（0600）；
  3. profile 不存在时先写骨架（`package.json` / `cordis.yml` / `pnpm-workspace.yaml`），已安装的插件补选 bundle，
     缺 `pnpm-workspace.yaml` 时补写；
  4. 首次安装插件前，用托管 Node 的 npm 在 `~/.dsh/remote-go/pnpm` 准备 pnpm，并写一个
     `~/.dsh/remote-go/bin/pnpm` shim（`dsh plugin` 需要 `PATH` 上的 pnpm）；
  5. 逐包 `dsh plugin --profile <p> add <name>@<version>`（失败记入 `failedPlugins`，不整单回滚）；
  6. 合并配置行并写回 patch（0600）；
  7. `dsh --profile <p> --dump-config` 校验组合可解析，并确认新装的包真实存在于 `node_modules`；
  8. 写 `sync/state.json`。
- **失败**：校验失败 → 用备份整份回滚 → 连接继续（`sync.status = failed`，日志说明）；回滚本身失败
  才升级为 `sync-failed` 错误并中止连接。

## 6. 协议与界面

- `HostView.sync = { enabled, credentials, plugins, status, at, hash, error, summary }`；
  `status ∈ idle | planned | syncing | applied | partial | failed`。
- 主机条目新增 `sync: { credentials, plugins }`，由 `POST /hosts` 保存，编辑时省略即保留。
- 新增 `POST /hosts/:id/sync`：停止远端 → 丢弃传输 → 以强制同步重新连接。
- 进度码：`sync-planning`、`sync-backup`、`sync-credentials`、`sync-config`、`sync-tooling`、
  `sync-plugins`、`sync-verifying`；连接窗口的日志里逐行可见。
- 添加 / 编辑主机的高级选项里是两个勾选，客户端只发送布尔值，不接触任何凭据内容。

## 7. 安全

- 凭据只经 SSH 通道传输，写在远端 0600 文件里；写文件走 `exec` 的 stdin（不出现在远端命令行）。
- 日志、`/state`、诊断与计划摘要只出现名字与计数，永不出现值；计划哈希里对值做 SHA-256。
- 配置行里可能本来就带着明文 key（某些插件把 key 存进自己的 config）；这类行会被同步并落在 0600
  的 patch 文件里，属于已知取舍，文档里明示。
- 同步不改变本地任何文件；远端 `hosts.json` 不保存任何远端凭据。

## 8. 测试

- `test/unit/sync.test.js`：registry spec 判定、可移植性、插件/行/凭据分类、patch 合并、
  plan 哈希稳定性、凭据合并（保留远端、只增记录、未知顶层键）、远端快照解析、命令引用与
  stdin 约定、主机字段与 `HostView`、semver 范围。
- 既有单测覆盖设置清洗、API 版本、客户端向导渲染；`pnpm run verify` 额外跑格式、语法、仓库规范与
  打包检查。

## 9. 后续

- v1.5：本地 `link:` / 私有插件打包上传；`records` 的自有凭据文件（隔离 provider 路径）；
  home 级 patch 行的显式选择。
- v2：漂移检测、同步包导出（离线 / 团队共用）、基于远端 DSH API 的热同步。
