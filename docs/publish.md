# 发布到 npm 与插件市场

> 目标：把 `dsh-remote-go` 作为标准 DSH bundle 发布到 npm，并进入插件市场索引（DSH Discover 可直接安装）。
> 本文所有校验命令都在本仓库验证过（见 §5「本地已验证」）。

## 0. 前置检查

```bash
node scripts/market-entry.mjs --check    # 包元数据 + 运行时文件 + format-1 索引校验
node scripts/pack-check.mjs              # files[] 覆盖检查
node --test "test/unit/*.test.js"        # 单测
node --test "test/e2e/*.e2e.js"          # 真实端到端（需测试主机 + 本机 Chrome）
```

`package.json` 关键字段（缺一不可）：

| 字段 | 作用 |
|---|---|
| `name` / `version` | npm 包名与精确版本（不可是 `private`） |
| `dsh.bundle.patch` | 作为 DSH bundle 被安装/启用的入口 |
| `dsh.client` | 浏览器半端声明（platform: web） |
| `engines.dsh` | 兼容区间；安装与启动都会用运行版本校验 |
| `files[]` | 必须包含 `index.js`、`client.js`、`src`、`locale`、`cordis.patch.yml` |
| `license` / `repository` / `keywords` | 市场展示与收录 |

## 1. 版本与变更

1. 更新 `package.json` 的 `version`（SemVer；预发布可用 `-rc.N`）。
2. 更新 `README.md` 状态与 CHANGELOG（如有）。
3. `node scripts/market-entry.mjs` 重新生成 `market/plugin-entry.json`、`market/index.json`（发布时间的来源是最近一次 git commit 时间，保证可复现）。

## 2. 发布到 npm

```bash
# 登录（一次性）
npm login                       # 或 CI 注入 NPM_TOKEN

# 预演（不上传）
npm publish --dry-run

# 正式发布（public）
npm publish --access public
```

> 本仓库使用 `pnpm` 打包时同样会执行 `prepack`（`node scripts/market-entry.mjs --check`）作为发布门禁。

发布后验证安装：

```bash
dsh plugin --profile web add dsh-remote-go@<version>
# 或本地 tarball 验证：
pnpm pack
dsh plugin --profile web add ./dsh-remote-go-<version>.tgz
```

## 3. 进入插件市场（两条路径，任选其一）

### 路径 A：自建 format-1 索引（最快，不依赖外部收录）

`node scripts/market-entry.mjs` 生成的 `market/index.json` 就是一个合法的 **format-1 插件市场索引**（单插件），可托管到任意 HTTPS/CDN（GitHub Pages、jsDelivr、自有域名），然后在 DSH 里：

1. **Plugins → Discover → Index sources** 添加该索引 URL；
2. 搜索 `dsh-remote-go` 一键安装；
3. 或对 Agent 使用 `plugin_market` 工具读取该索引并 `plugin_manager install_bundle`。

也可以直接用 npm 作为分发载体托管索引（例如发布 `dsh-plugin-catalog` 包，把 `index.json` 放进包内，用 jsDelivr 访问 `https://cdn.jsdelivr.net/npm/<pkg>/index.json`）。

### 路径 B：收录进社区市场（awesome-dsh-plugin）

社区插件市场（`dshmarket`）的列表来自精选仓库 **[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**。收录方式：

1. 先完成 §2 的 npm 发布；
2. Fork 该仓库，在插件列表中按现有格式新增一条 `dsh-remote-go` 条目（名称、一句话描述、npm 包名、仓库链接、分类/标签）；
3. 提交 PR（一个条目即可；站点与市场会自动同步，通常 1 天内生效）。

PR 条目可直接复制 `market/plugin-entry.json` 的中英标题与描述：

```json
{
  "name": "dsh-remote-go",
  "title": { "zh": "远程入口", "en": "Remote entry" },
  "description": {
    "zh": "通过 SSH 在本地 DSH 的全局面板里整页使用远端 DSH：主机清单、接入向导、连接诊断、远端运行时自举与版本一致。",
    "en": "Open a remote DSH inside a local full-page panel over SSH, with host list, connection wizard, diagnostics, remote runtime bootstrap and exact version parity."
  }
}
```

> 注意：本仓库是插件本身，不是市场应用；不要向市场应用仓库提插件条目。

## 4. 发布物内容与安全性

- tarball 只包含运行时文件（`index.js`、`client.js`、`src/`、`locale/`、`cordis.patch.yml`、`README.md`、`LICENSE`），不含测试、E2E、研究资料（`scripts/pack-check.mjs` 校验）。
- 运行时依赖仅 `ssh2`（纯 JS；`--ignore-scripts` 安装也可用）。
- 无 postinstall / build 脚本，安装不会执行任意代码。
- Host 半端只使用 Node 内置模块 + `ssh2`；不 import DSH 内部包，降低版本耦合。
- 令牌/密码/私钥绝不落盘（详见 README 安全节）。

## 5. 本地已验证

| 项目 | 结果 |
|---|---|
| `scripts/market-entry.mjs --check` | 通过：官方 `@deepseek-ai/dsh-plugin-market-index` 校验 format-1 索引 |
| `scripts/check-syntax.mjs` / `scripts/check-workflows.mjs` | 通过：全部 JS/工作流文件可解析；CI workflow 通过真实 YAML 解析器校验 |
| `pnpm publish --dry-run --no-git-checks` | 通过：`prepack` 门禁执行、包内容与 registry 目标校验通过（本环境无 npm 登录态，未真正上传） |
| `pnpm pack` + `scripts/pack-check.mjs --find artifacts` | 通过：tarball 仅含运行时文件（index/client/src/vendor/locale/patch/README/LICENSE），必需文件齐全 |
| 从 tarball 安装到干净 DSH profile | 通过（`test/e2e/publish.e2e.js`）：`dsh plugin add <tgz>` → 启动 → `/dsh-remote-go/api/health` 200、`/diagnostics/self` 显示 Host 入口 + client-module 行，且 `clientPath` 位于安装 profile 内而非开发目录 |
| 从目录链接安装（开发模式） | 通过（`test/e2e/plugin.e2e.js`）：真实 SSH + 真实远端 DSH + 无头 Chrome 面板 iframe 端到端验收 |
| `engines.dsh` 兼容校验 | 运行版本 0.2.2-rc.1 满足 `>=0.2.2-rc.1` |

> 真正上传 npm 只差一步：维护者执行 `npm login`（或 CI 注入 `NPM_TOKEN`）后运行 `npm publish --access public`。本环境没有 npm 登录态，因此没有执行对外可见的发布动作。

## 6. 发布后检查清单

- [ ] npm 页面展示 README、LICENSE、keywords 正确
- [ ] `dsh plugin --profile web add dsh-remote-go@<version>` 全新 profile 安装成功，侧边栏出现「远程入口」
- [ ] 首次连接向导可完成：指纹确认 → 远端自举 → 面板整页打开远端 DSH
- [ ] 断线重连、诊断、设置可用
- [ ] 市场索引条目可解析、可一键安装（路径 A 或 B）
- [ ] 升级后回滚路径：`dsh plugin --profile web add dsh-remote-go@<旧版本>` 可用
