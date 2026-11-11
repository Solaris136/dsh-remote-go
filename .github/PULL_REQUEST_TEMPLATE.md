# Pull Request

> 标题必须是 Conventional Commit 格式（见文末），因为仓库使用 squash merge，
> PR 标题会直接成为 `main` 上的提交标题。

## 概述

<!-- 这个改动为什么存在、做了什么；一两段足够。 -->

## 关联 issue

<!-- 例：Closes #12 / Refs #34；没有关联 issue 时写「无」并说明原因。 -->

## 变更类型

- [ ] `feat` 新功能
- [ ] `fix` 缺陷修复
- [ ] `docs` 文档
- [ ] `refactor` 重构（不改变行为）
- [ ] `perf` 性能
- [ ] `test` 测试
- [ ] `ci` CI / 仓库自动化
- [ ] `chore` 杂项（依赖、构建、脚手架）
- [ ] `breaking` 破坏性变更（需要在 CHANGELOG 中标记 BREAKING CHANGE）

## 测试与验证

- [ ] `pnpm run verify` 通过
- [ ] 新增或更新了对应的单元测试
- [ ] 如果改动了 SSH / tunnel / bootstrap，附上 E2E 运行证据（命令与结果摘要，注意脱敏）

## 安全检查

- [ ] 没有提交凭据、token、私钥或含具体主机信息的 E2E 产物（`e2e/remote/evidence` 等）
- [ ] 没有新增运行时依赖（`dependencies` 保持为空；新工具只能进 `devDependencies`）
- [ ] 没有把用户输入拼接进 shell 命令（一律通过参数或 `env:` 传递）
- [ ] 面板 iframe 的 URL 校验逻辑未被削弱（只允许本机回环地址）

## 文档与发布

- [ ] 更新了 README / `docs/` 中受影响的说明
- [ ] 在 CHANGELOG 的 `Unreleased` 段落补了一条用户可感知的变更

---

标题格式：`<type>(<scope>): <subject>`，例如 `fix(tunnel): keep the SSH channel alive on idle`
