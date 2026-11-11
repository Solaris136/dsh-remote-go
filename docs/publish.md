# 发布到 npm 与插件市场

> 目标：把 `dsh-remote-go` 作为标准 DSH bundle 发布到 npm，并进入插件市场索引（DSH Discover 可直接安装）。
> 推荐路径是**推送 `v*` 标签触发 `.github/workflows/release.yml`**；手工发布仅作为应急手段保留。

## 0. 前置检查

发布前在干净工作区跑一遍与 CI 相同的门禁：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify        # lint + check:syntax + check:workflows + market:check + pack:check + test:unit
```

端到端（需要真实测试主机与本机浏览器，非必需门禁）：

```bash
pnpm run test:e2e
```

`package.json` 关键字段（缺一不可）：

| 字段 | 作用 |
|---|---|
| `name` / `version` | npm 包名与精确版本（不可是 `private`） |
| `dsh.bundle.patch` | 作为 DSH bundle 被安装/启用的入口 |
| `dsh.client` | 浏览器半端声明（platform: web） |
| `engines.dsh` / `engines.node` | 兼容区间；安装与启动都会用运行版本校验 |
| `files[]` | 必须包含 `index.js`、`client.js`、`src`、`locale`、`cordis.patch.yml` |
| `license` / `repository` / `homepage` / `bugs` / `keywords` | 市场展示、收录与问题反馈入口 |
| `packageManager` | 固定 pnpm 版本，CI 与本地一致 |

## 1. 版本与变更

1. 确认 `main` 是最新的，且 CI 全绿。
2. 按 SemVer 更新 `package.json` 的 `version`（预发布可用 `-rc.N`）。
3. 把 `CHANGELOG.md` 中 `## [Unreleased]` 的内容整理进新的 `## [x.y.z] - YYYY-MM-DD` 小节，并更新文件末尾的链接引用。
4. 重新生成市场条目（发布时间取自最近一次 git commit，结果可复现）：

   ```bash
   pnpm run market:entry     # 写入 market/plugin-entry.json 与 market/index.json
   pnpm run market:check     # 校验（prepack 也会跑）
   ```

5. 提交并推送：`chore(release): v<x.y.z>`。
6. 打标签并推送标签：`git tag -a v<x.y.z> -m "v<x.y.z>"` → `git push origin v<x.y.z>`。

`release.yml` 会校验标签与 `package.json` 版本严格相等（例如 `v0.1.0` ↔ `0.1.0`），不一致直接失败，避免发错版本。

## 2. 通过 GitHub Actions 发布（推荐）

推送 `v*` 标签后，[`release.yml`](../.github/workflows/release.yml) 依次执行：

1. 检出代码，安装依赖（`--frozen-lockfile --ignore-scripts`）。
2. 跑全部门禁（`lint` / `check:syntax` / `check:workflows` / `market:check` / `pack:check` / `test:unit`）。
3. 校验标签与版本一致。
4. `pnpm pack` 后对 tarball 再校验（`pack:check:tarball`）。
5. 若仓库配置了 secret `NPM_PUBLISH_TOKEN`：`npm publish --access public --provenance`（带构建来源证明）。
   未配置该 secret 时输出一条 notice 并跳过发布，工作流仍会继续创建 GitHub Release。
6. `gh release create` 创建 GitHub Release，自动生成 release notes，并附上 `.tgz` 产物。

需要的一次性配置：

| 类型 | 名称 | 说明 |
|---|---|---|
| Secret | `NPM_PUBLISH_TOKEN` | npm Automation token（仅发布用，可撤销）；不配置则只发 GitHub Release |
| Secret | `E2E_SSH_PRIVATE_KEY` | 仅 `e2e.yml` 使用，能登录测试主机的私钥 |
| Secret | `E2E_SSH_KNOWN_HOSTS` | 可选，预置 known_hosts 行；不配置则用 `ssh-keyscan` |
| Variable | `E2E_SSH_ADDRESS` | 测试主机地址/别名（`e2e.yml` 手动触发时的默认值） |

也可以用 `workflow_dispatch` 手动触发并传入 `tag`；`dry_run=true`（默认）只演练不发布、不建 Release。

## 3. 手工发布（应急）

```bash
npm login                                    # 一次性
pnpm run verify                              # 门禁
npm publish --dry-run                        # 预演（不上传）
npm publish --access public --provenance     # 正式发布
```

> 手工发布没有 `provenance` 签名之外的溯源信息，也没有 Release notes；因此除紧急情况外请走 §2。

发布后验证安装：

```bash
dsh plugin --profile web add dsh-remote-go@<version>
# 或本地 tarball 验证：
pnpm pack
dsh plugin --profile web add ./dsh-remote-go-<version>.tgz
```

## 4. 进入插件市场（两条路径，任选其一）

### 路径 A：自建 format-1 索引（最快，不依赖外部收录）

`pnpm run market:entry` 生成的 `market/index.json` 就是一个合法的 **format-1 插件市场索引**（单插件），可托管到任意
HTTPS/CDN（GitHub Pages、jsDelivr、自有域名），然后在 DSH 里：

1. **Plugins → Discover → Index sources** 添加该索引 URL；
2. 搜索 `dsh-remote-go` 一键安装；
3. 或对 Agent 使用 `plugin_market` 工具读取该索引并 `plugin_manager install_bundle`。

也可以直接用 npm 作为分发载体托管索引（例如发布 `dsh-plugin-catalog` 包，把 `index.json` 放进包内，用 jsDelivr 访问
`https://cdn.jsdelivr.net/npm/<pkg>/index.json`）。

### 路径 B：收录进社区市场（awesome-dsh-plugin）

社区插件市场（`dshmarket`）的列表来自精选仓库
**[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**。收录方式：

1. 先完成 §2 的 npm 发布；
2. Fork 该仓库，在插件列表中按现有格式新增一条 `dsh-remote-go` 条目（名称、一句话描述、npm 包名、仓库链接、分类/标签）；
3. 提交 PR（一个条目即可；站点与市场会自动同步，通常 1 天内生效）。

PR 条目可直接复制 `market/plugin-entry.json` 的中英标题与描述：

```json
{
  "name": "dsh-remote-go",
  "title": { "zh": "dsh remote go", "en": "dsh remote go" },
  "description": {
    "zh": "通过 SSH 在本地 DSH 的全局面板里整页使用远端 DSH：主机清单、接入向导、连接诊断、远端运行时自举与版本一致。",
    "en": "Open a remote DSH inside a local full-page panel over SSH, with host list, connection wizard, diagnostics, remote runtime bootstrap and exact version parity."
  }
}
```

> 注意：本仓库是插件本身，不是市场应用；不要向市场应用仓库提插件条目。

## 5. 发布物内容与安全性

- tarball 只包含运行时文件（`index.js`、`client.js`、`src/`、`vendor/`、`locale/`、`cordis.patch.yml`、`README.md`、
  `LICENSE`），不含测试、E2E、研究资料（`scripts/pack-check.mjs` 校验）。
- 运行时依赖为空（`dependencies: {}`）。`ssh2` 以 vendored bundle 形式随包发布，安装不拉取任何依赖。
- 无 postinstall / build 脚本，安装不会执行任意代码。
- Host 半端只使用 Node 内置模块 + vendored `ssh2`；不 import DSH 内部包，降低版本耦合。
- 令牌/密码/私钥绝不落盘（详见 README 安全节与 [SECURITY.md](../SECURITY.md)）。

## 6. 首次发布时补上 npm 徽章

`README.md` 目前只有 CI / CodeQL / Release / License / 运行时版本徽章。npm 包首次发布后，可在徽章区补一行：

```markdown
[![npm](https://img.shields.io/npm/v/dsh-remote-go.svg)](https://www.npmjs.com/package/dsh-remote-go)
```

## 7. 发布后检查清单

- [ ] npm 页面展示 README、LICENSE、keywords 正确
- [ ] GitHub Release 已生成，notes 与 `CHANGELOG.md` 一致，附带 `.tgz`
- [ ] `dsh plugin --profile web add dsh-remote-go@<version>` 在全新 profile 安装成功
- [ ] 首次连接向导可完成：指纹确认 → 远端自举 → 面板整页打开远端 DSH
- [ ] 断线重连、诊断、设置可用
- [ ] 市场索引条目可解析、可一键安装（路径 A 或 B）
- [ ] 升级后回滚路径：`dsh plugin --profile web add dsh-remote-go@<旧版本>` 可用

## 8. 历史验证记录（0.1.0 之前）

以下结果在维护者机器上验证过，作为发布路径的既有证据保留；新版本以 CI 与 `pnpm run verify` 为准。

| 项目 | 结果 |
|---|---|
| `scripts/market-entry.mjs --check` | 通过：官方 `@deepseek-ai/dsh-plugin-market-index` 校验 format-1 索引 |
| `scripts/check-syntax.mjs` / `scripts/check-workflows.mjs` | 通过：JS 可解析；workflow 通过真实 YAML 解析器校验 |
| `pnpm publish --dry-run --no-git-checks` | 通过：`prepack` 门禁执行、包内容与 registry 目标校验通过 |
| `pnpm pack` + `scripts/pack-check.mjs --find artifacts` | 通过：tarball 仅含运行时文件，必需文件齐全 |
| 从 tarball 安装到干净 DSH profile | 通过（`test/e2e/publish.e2e.js`）：API 200、client-module 从安装目录加载 |
| 从目录链接安装（开发模式） | 通过（`test/e2e/plugin.e2e.js`）：真实 SSH + 真实远端 DSH + 无头浏览器面板 iframe |
| `engines.dsh` 兼容校验 | 运行版本 0.2.2-rc.1 满足 `>=0.2.2-rc.1` |
