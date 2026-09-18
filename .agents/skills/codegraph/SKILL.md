---
name: codegraph
description: 在 Billy 工程中用 codegraph 代码图谱工具快速理解代码：MCP 工具 codegraph_explore 与 CLI（query / node / callers / callees / impact / affected / files）查符号、调用关系、改动影响面，替代 grep / glob / read 逐文件爬；用于架构理解、依赖方向验证、改动评估。触发词：codegraph、代码图谱、调用关系、调用链、依赖图、影响面、blast radius、谁调用、代码理解、架构理解、codegraph_explore、callers、callees、impact。
---

# codegraph 代码图谱

前置：先加载必读 skill `billy-dev-foundation`（分层铁律——codegraph 可**辅助验证**依赖方向，
但工程约束仍以 `code-conventions.md` 为准；codegraph 是理解工具，不是规范来源）。

## 核心要点

- codegraph 是**预索引代码知识图谱**（符号 / 调用边 / 依赖，100% 本地，Rust kernel），让 agent
  用一次调用拿到相关源码 + 调用路径 + 影响面，替代 grep / glob / read 逐文件爬。
- **优先用 MCP 工具 `codegraph_explore`**（DSH 不在 `codegraph install` 支持列表，需手动接入，
  见 references/codegraph-guide.md 第 1 节）：一次回答「X 怎么工作」「X 到 Y 的流程」「改 X 影响谁」。
- **CLI 等价命令**（任何 agent 经 bash 调，未接 MCP 时用这个）：`codegraph query <q>`（搜索）、
  `node <symbol|file>`（读符号 / 文件）、`callers <symbol>` / `callees <symbol>`（调用关系）、
  `impact <symbol>`（影响面）、`affected [files]`（受影响测试）、`files [path]`（文件结构）。
- **billy 用法**：验证分层依赖方向（shared 不依赖业务、kits 不 import apps/*）用 `callers` /
  `impact` 查反向依赖——这两者**实测准确可靠**；**正向 DI 调用链（`callees`）不可靠**：显式
  `@Inject` + tsx 不产出 metadata，`this.xxx.method()` 调用边建不出、`@Post` 等装饰器还会误判，
  追调用链用 `callers`（反向）+ `read`（正向），别指望 `callees`。`query` 按符号名 / FTS5，
  用英文标识符，不支持中文语义。
- **索引同步有前提**：只有 `codegraph serve --mcp`（自带文件 watcher）或 daemon 在跑才自动更新；
  未接 MCP / daemon 时索引会静默过期（图谱返回旧代码），改完须手动 `codegraph sync`，
  `codegraph status` 会列出 Added / Modified 待同步文件。`.codegraph/` 不入库（已在 `.gitignore`）。
- **克制**：简单单文件小改不必上图谱，直接 read 更快；图谱用于「跨文件理解 / 调用链 / 影响面」。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/codegraph-guide.md](./references/codegraph-guide.md) | 安装接入、CLI 速查、MCP 工具、codegraph.json 配置、billy 特定用法 | 接入 / 首次使用 / 查命令时（必读） |

## 完成检查清单

- [ ] 理解架构 / 调用关系 / 影响面时，先用 codegraph（explore / query / callers / impact），未逐文件 grep/read 爬
- [ ] 简单单文件修改未滥用图谱（直接 read）
- [ ] 未把 `.codegraph/` 提交入库
- [ ] 结论最终落回 `billy-dev-foundation` 的分层铁律与 code-conventions，未把图谱结果当规范本身
