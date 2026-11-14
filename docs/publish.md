# 发布到 npm 与插件市场
> 目标：把 `dsh-remote-go` 作为标准 DSH bundle 发布到 npm，并进入插件市场索引（DSH Discover 可直接安装）。
> 推荐路径：**推送 `v*` 标签触发 `.github/workflows/release.yml`**；手工发布仅作应急。

## 0. 前置检查
发布前在干净工作区跑与 CI 相同的门禁：
```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify   # 仓库规范 + 格式 + 语法 + workflow + 市场条目 + 打包 + 单测 + 集成
```
端到端（需真实测试主机与本机浏览器，非必需门禁）：`pnpm run test:e2e`。

`package.json` 关键字段（缺一不可）：

| 字段 | 作用 |
|---|---|
| `name` / `version` | npm 包名与精确版本（不可 `private`） |
| `dsh.bundle.patch` | 作为 DSH bundle 被安装/启用的入口 |
| `dsh.client` | 浏览器半端声明（platform: web） |
| `engines.dsh` / `engines.node` | 兼容区间；安装与启动都用运行版本校验 |
| `files[]` | 必须含 `index.js`、`client.js`、`src`、`locale`、`cordis.patch.yml` |
| `license` / `repository` / `homepage` / `bugs` / `keywords` | 市场展示、收录与问题反馈入口 |
| `packageManager` | 固定 pnpm 版本，CI 与本地一致 |

## 1. 版本与变更
1. 确认 `main` 最新且 CI 全绿。
2. 按 SemVer 更新 `package.json` 的 `version`（预发布可用 `-rc.N`）。
3. 把 `CHANGELOG.md` 中 `## [Unreleased]` 的内容整理进新的 `## [x.y.z] - YYYY-MM-DD` 小节，并更新文件末尾的链接引用。
4. 重新生成市场条目（发布时间取自最近一次 git commit，结果可复现）：`pnpm run market:entry`（写 `market/plugin-entry.json` 与 `market/index.json`）与 `pnpm run market:check`（校验；prepack 也会跑）。
5. 提交并推送：`chore(release): v<x.y.z>`。
6. 打标签并推送：`git tag -a v<x.y.z> -m "v<x.y.z>"` → `git push origin v<x.y.z>`。

`release.yml` 会校验标签与 `package.json` 版本严格相等（`v0.1.0` ↔ `0.1.0`），不一致直接失败。

## 2. 通过 GitHub Actions 发布（推荐）
推送 `v*` 标签后，[`release.yml`](../.github/workflows/release.yml) 依次：
1. 检出代码、安装依赖（`--frozen-lockfile --ignore-scripts`），跑发布门禁（`lint` / `check:syntax` / `check:workflows` / `market:check` / `pack:check` / `test:unit`）。
2. 校验标签与版本一致。
3. `pnpm pack` 后对 tarball 再校验（`pack:check:tarball`）。
4. 配置了 secret `NPM_PUBLISH_TOKEN` 则 `npm publish --access public --provenance`；未配置则输出 notice 并跳过发布，仍创建 GitHub Release。
5. `gh release create` 创建 GitHub Release，自动生成 notes 并附上 `.tgz`。

需要的一次性配置：

| 类型 | 名称 | 说明 |
|---|---|---|
| Secret | `NPM_PUBLISH_TOKEN` | npm Automation token（仅发布用，可撤销）；不配置则只发 GitHub Release |

也可用 `workflow_dispatch` 手动触发并传入 `tag`；`dry_run=true`（默认）只演练不发布、不建 Release。

## 3. 手工发布（应急）
```bash
npm login                                    # 一次性
pnpm run verify                              # 门禁
npm publish --dry-run                        # 预演（不上传）
npm publish --access public --provenance     # 正式发布
```
> 手工发布没有 Release notes（`provenance` 签名仍在），除紧急情况外请走 §2。

发布后验证安装：
```bash
dsh plugin --profile web add dsh-remote-go@<version>
pnpm pack
dsh plugin --profile web add ./dsh-remote-go-<version>.tgz
```

## 4. 进入插件市场（任选其一）
### 路径 A：自建 format-1 索引
`pnpm run market:entry` 生成的 `market/index.json` 是合法的 **format-1 插件市场索引**（单插件），可托管到任意 HTTPS/CDN（GitHub Pages、jsDelivr、自有域名），然后在 DSH 里：

1. **Plugins → Discover → Index sources** 添加该索引 URL，搜索 `dsh-remote-go` 一键安装；
2. 或让 Agent 用 `plugin_market` 工具读取该索引并 `plugin_manager install_bundle`。

也可用 npm 作为分发载体（例如发布 `dsh-plugin-catalog` 包，用 jsDelivr 访问 `https://cdn.jsdelivr.net/npm/<pkg>/index.json`）。

### 路径 B：收录进社区市场（awesome-dsh-plugin）
社区市场（`dshmarket`）列表来自 **[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**：

1. 先完成 §2 的 npm 发布；
2. Fork 该仓库，按现有格式新增一条 `dsh-remote-go` 条目（名称、一句话描述、npm 包名、仓库链接、分类/标签）；
3. 提交 PR（一个条目即可；站点与市场会自动同步，通常 1 天内生效）。

PR 条目的中英标题与描述**不要手抄**：它们由 `locale/zh.json` / `locale/en.json` 的 `meta` 生成到 `market/plugin-entry.json`（`node scripts/market-entry.mjs --check` 会和多语言源比对）。直接从 `market/plugin-entry.json` 复制 `title` / `description` 两个字段即可。

> 本仓库是插件本身，不是市场应用；不要向市场应用仓库提插件条目。

## 5. 发布物内容与安全性
- tarball 只含运行时文件（`index.js`、`client.js`、`src/`、`vendor/`、`locale/`、`cordis.patch.yml`、`README.md`、`LICENSE`），不含测试、E2E、研究资料（`scripts/pack-check.mjs` 校验）。
- 运行时依赖为空（`dependencies: {}`）；`ssh2` 以 vendored bundle 随包发布，安装不拉取任何依赖。
- 无 postinstall / build 脚本，安装不会执行任意代码；Host 半端只用 Node 内置模块 + vendored `ssh2`，不 import DSH 内部包；令牌/密码/私钥绝不落盘（详见 README 安全节与 [SECURITY.md](../SECURITY.md)）。

## 6. 首次发布后补 npm 徽章
`README.md` 目前只有 CI / CodeQL / License / Node / DSH 徽章；npm 首次发布后可在徽章区补一行：
```markdown
[![npm](https://img.shields.io/npm/v/dsh-remote-go.svg)](https://www.npmjs.com/package/dsh-remote-go)
```

## 7. 发布后检查清单
- [ ] npm 页面展示 README、LICENSE、keywords 正确
- [ ] GitHub Release 已生成，notes 与 `CHANGELOG.md` 一致，附带 `.tgz`
- [ ] `dsh plugin --profile web add dsh-remote-go@<version>` 在全新 profile 安装成功
- [ ] 首次连接向导可完成：指纹确认 → 远端环境探测 → 托管 Node 准备 → npx 预检 → 远端 DSH 接管整窗
- [ ] 断线重连、诊断、设置可用
- [ ] 市场索引条目可解析、可一键安装（路径 A 或 B）
- [ ] 升级后回滚路径：`dsh plugin --profile web add dsh-remote-go@<旧版本>` 可用
