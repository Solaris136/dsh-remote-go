# 安全策略（Security Policy）

> **English abstract.** This plugin gives a local DSH full-page access to a remote DSH over SSH, so the surface is
> the SSH hop, the launch token, host-key verification, the loopback tunnel, the remote bootstrap templates and the
> local HTTP API. Report vulnerabilities privately through GitHub Security Advisories
> (<https://github.com/Solaris136/dsh-remote-go/security/advisories/new>); please do not open a public issue.
> Targets: acknowledge within 72 hours, triage within 7 days, coordinated disclosure within 90 days. Only 1.x is
> supported. The rest of the document is written in Chinese, the project's primary language.

## 支持的版本

| 版本 | 安全支持 |
|---|---|
| `1.x`（当前 `1.0.0` 起） | ✅ 接收安全报告，修复以补丁版本发布 |
| `< 1.0.0`（含 `0.1.x` 快照） | ❌ `1.0.0` 发布后不再提供安全修复；请先升级再报告 |

`1.0.0` 是首个公开发布版本。预发布 / 快照版本（`0.1.x`）之间没有兼容承诺，也不做安全回补；如果你仍在旧快照上，
请先升级到最新 `1.x` 并确认问题仍可复现。

## 如何报告（请走私密渠道）

**不要**通过公开 issue、PR 评论、讨论区或社交平台披露漏洞细节。

推荐渠道：**GitHub Security Advisories（私密漏洞报告）**

<https://github.com/Solaris136/dsh-remote-go/security/advisories/new>

（也可在仓库 **Security** 标签页点击「Report a vulnerability」。）

如果暂时无法使用 GitHub 私有报告，可以先开一个**不含任何细节**的 issue，只写「需要私下安全联系」，维护者会跟进建立
私密渠道；不要把 PoC、日志或凭据贴进那个 issue。

报告里请尽量包含：

- 受影响的版本或 commit，以及本机 OS 与 DSH 版本；
- 受影响的组件（Host 插件 / Client 半端 / 自举 / 隧道 / 本地 API / 诊断）；
- 复现步骤或最小 PoC，以及实际影响（能做什么、需要什么前置条件）；
- 是否已经公开、是否计划公开，以及你希望的披露时间。

## 响应时限（目标值，非 SLA）

| 阶段 | 目标 |
|---|---|
| 确认收到 | 72 小时内 |
| 初步评估（分级与影响范围） | 7 天内 |
| 协调披露 | 90 天内（自确认起算，可协商） |

以上是**目标**而非保证：本仓库由个人维护，遇到节假日或复杂问题可能延后。我们会在 advisory 里同步进展；如果需要更长时间
修复，会提前说明原因并与报告者协商披露时间。

## 范围

### 在范围内

1. **SSH 凭据处理**：密码/密钥/Agent 的使用与生命周期；密码不得落盘；`secrets.json` 等本地文件的权限（0600/0700）。
2. **访问令牌处理**：远端 `dsh web` 启动令牌的获取、内存保存、日志出现与 `saveTokens` 可选落盘路径。
3. **主机指纹校验绕过**：`hostVerifier`、`known_hosts` 只读解析、首次确认与指纹变化的阻断、strict 策略被绕过。
4. **隧道对外暴露**：本地隧道监听非回环地址（应为 `127.0.0.1`）；远端服务被绑到非回环地址或可被局域网/公网直连。
5. **远端自举命令注入**：白名单模板之外的命令拼接、版本号/路径/架构等参数注入、Node 下载包的 SHA-256 校验被跳过。
6. **本地 HTTP API 的 CSRF / Origin 校验**：`x-dsh-remote-go` 请求头、同源 `Origin`、`sec-fetch-site` 栅栏与 `/events` 的
   EventSource 例外处理被绕过，导致任意站点可驱动本地 API。
7. **iframe URL 校验**：面板只接受 `http://127.0.0.1:<port>` 的 URL；绕过该校验导致任意 URL 被嵌入或令牌被带出。
8. **诊断/日志脱敏绕过**：`src/redact.js` 的脱敏被绕过，导致「一键复制诊断」或导出的日志泄露 token、密码、私钥或家目录。

### 不在范围内

- **DSH 本体（`@deepseek-ai/dsh` 及其子包）的漏洞**：请报告给上游 DSH 项目；本插件只负责 SSH 连接、承载与状态。
- **远端主机的系统层问题**：OS 补丁、OpenSSH 配置、账号/权限/sudo、磁盘加密、防火墙策略。
- **被入侵前提下的问题**：攻击者已能在本机或远端执行任意代码、或能物理接触设备。
- **社会工程**：钓鱼、诱导用户粘贴令牌、冒充维护者等（报告我们仍会看，但通常不在代码修复范围）。
- **Self-XSS**：用户把恶意脚本粘贴进自己的 DevTools/控制台。
- **仅监听 `127.0.0.1` 的端点缺失安全响应头**（HSTS、CSP 等浏览器纵深防护）：这些端点不可从网络访问，缺失响应头
  本身不构成可利用漏洞。
- **第三方依赖的已知漏洞**：如果不在本插件的可达代码路径上，或上游已发布修复但本仓库尚未升级（升级请走正常 PR）。

## 设计上的安全边界（便于评估）

- 远端 DSH 只绑 `127.0.0.1`，本地通过 SSH `forwardOut` 隧道访问；本地不监听公网地址。
- 本地 HTTP API 要求自定义请求头 + 同源 `Origin`，跨站请求被拒绝。
- 访问令牌默认只在内存；`saveTokens=true` 时才以 0600 写入本地文件；密码永不落盘。
- 主机指纹首次显式确认，变化时阻断并强提示；`strict` 策略下未记录指纹直接拒绝。
- 远端自举只执行固定白名单模板命令，不接受用户拼接的任意 shell；Node 下载校验 SHA-256。

## 安全港（Safe Harbour）

我们支持出于善意的安全研究。只要满足以下条件，我们就不会就你的研究行为采取法律行动或向平台投诉：

- 只在**你自己拥有或已获得明确授权**的环境中测试（本机 + 你控制的测试主机，不要碰第三方服务器与账号）；
- 不访问、不修改、不泄露他人的数据，不破坏服务可用性，不进行拒绝服务、暴力破解或大规模扫描；
- 在公开披露前给我们合理的修复与发布窗口（默认按上方 90 天协调披露，可协商）；
- 遵守适用的法律法规。

符合条件的报告，我们会在 advisory / 发布说明中致谢（如果你愿意具名）。请优先在本地与测试主机上验证；
`e2e/` 下的脚本与说明可参考。

## 附带日志与证据前请自查

- 「复制诊断信息」默认脱敏 token、密码、私钥与家目录（`src/redact.js`），但**不保证覆盖全部**：主机名、用户名、路径、
  远端日志片段仍可能含敏感信息。
- 附件前请自行复核并删除：真实主机地址/用户名、`secrets.json`、`e2e/remote/.token`、`*.log`、浏览器 cookie 导出。
- **特别注意 `e2e/remote/evidence`**：E2E 证据目录里有 HTTP 头、cookie jar 片段、响应体与页面内容（含远端 DSH 首页
  HTML），其中 cookie jar 与响应头可能直接带着访问令牌；这些只是本地测试产物，**在把它们贴进 issue、advisory 或任何
  公开位置之前，请逐个人工清理**。
- 报告漏洞时不要粘贴可用的真实令牌；请用占位值说明问题。

## 修复与披露

- 修复在私密 advisory 的分支/草稿上进行，避免在公开 PR 中提前暴露细节。
- 修复发布后公开 advisory，说明影响版本、修复版本与（在同意的前提下）报告者致谢；视影响范围决定是否申请 CVE。
- 如果你已经公开披露且我们尚未修复，我们仍会尽快处理，但无法保证协调节奏。
