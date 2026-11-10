# dsh-remote-go · DSH 远程入口

> 在本地 DSH 里，通过 SSH 整页打开服务器上的 DSH。本地只负责连接、入口与状态。

**状态：设计阶段** —— 产品与内容设计 v0.6 已定稿，尚未开始实现。

- 设计文档：[docs/design.md](docs/design.md)
- 同类项目调研：[docs/research-competitors.md](docs/research-competitors.md)
- 最接近项目专项调研：[docs/research-dsh-remote-window.md](docs/research-dsh-remote-window.md)

## 它是什么

- 一个 DeepSeek Harness（DSH）插件：在本机 DSH 的侧边栏新增「远程入口」。
- 添加一台服务器（SSH）后，点开即可在本机 DSH 的主区域**整页**使用服务器上的 DSH。
- 会话、审批、文件、终端、插件、凭据、日志——全部由远端 DSH 自己的界面提供，本地不重做。
- 本地只做四件事：主机清单、SSH 连接与隧道、全局面板承载、连接状态与断线重连。

## 核心能力（规划）

| 能力 | 版本 |
|---|---|
| 主机清单 / 接入向导 / 连接状态诊断 | V1.0 |
| 全局面板整页呈现远端 DSH 界面 | V1.0 |
| 远端自举：npx 精确版本 / 无 Node 下载运行时 / 离线包 | V1.0 |
| 远端版本与本机一致（不一致不静默混用） | V1.0 |
| 本机关闭后远端存活（保持运行 / 退出即停 / 空闲停止，可配） | V1.0 |
| 断线自动重连 / 远端服务一键启动 | V1.0 |
| 沉浸模式（全屏覆盖）/ 多主机 / 通知提醒 / 最近打开 | V1.1 |
| 远端设置在本机配置（diff / 备份 / 按需重启） | V1.2 |
| 远端插件：使用远端 DSH 插件市场（本地不单独实现） | — |
| 原生渲染（可选增强） | V2 评估 |

## 为什么是「薄客户端」

按 VS Code Remote-SSH 的思路：运行时留在服务器，本地只做呈现。DSH 原生支持「全局面板」整页切换（与 DSH 自带「插件」页同一种形态），所以本地不需要实现会话/审批/文件/终端等界面——把远端 DSH 的界面放进面板即可。

## 不是什么

- 不是另一套远程会话 UI（不重写聊天、审批、文件、终端）。
- 不需要在服务器安装本插件专属组件，远端只需原版 DSH（没有环境时可用 npx/离线包自举）。
- 不做公网穿透/中转；只依赖已有 SSH 可达性（含跳板机）。
- V1 不支持 Windows 服务器；不做团队协作。

## 仓库结构

```
docs/design.md                      产品与内容设计（v0.6）
docs/research-competitors.md        同类项目调研与需求/注意点
docs/research-dsh-remote-window.md  dsh-remote-window 专项调研（最接近项目）
README.md                           本文件
```

## License

TBD（待定）。
