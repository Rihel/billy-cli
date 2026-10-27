# 开发会话记录怎么查

> **查证优先级：抽核** —— 路径与格式属于结构性事实，工具换了才失效。
> 用前确认一眼：`ls ~/.dsh/sessions/--Users-rihel-workspace-billy-cli--/ | head -3`，
> 文件名不是 `session.v4.jsonl.zstd` 就先别按本卡操作。

## 结论

开发这个仓库的会话记录在：

```
~/.dsh/sessions/--Users-rihel-workspace-billy-cli--/session-*/session.v4.jsonl.zstd
```

- zstd 压缩的 JSONL，一行一个事件；`zstd -dc <文件>` 直接看
- 事件类型：`tool/call`（`data.name` + `arguments`）、`tool/result`（`data.message.content[].text`）、
  `assistant/message`、`system/message`、`step/start`、`compaction/*`、`turn/start`
- 单个会话压缩后可达 4MB、解压 14MB；遍历全部会话会吃掉大量上下文，脚本里用流式处理、只打印结论
- 会话文件不记录 provider 侧的 usage，token 只能按消息文本长度估（中文约 1.5–2 字符 / token）

## 用途

- 核对「某个说法有没有真实发生过」，而不是凭印象
- 统计工具调用形态、输出体量、压缩有没有触发

## 依据

2026-10-25 实测：用该方式统计出 12 个会话的调用数与输出构成（见 `token-cost-model.md`）。

## 失效信号

DSH 改成 `session.v5` 或换存储位置后，路径与格式都要重查。
Claude Code 的会话记录在 `~/.claude/projects/`，格式不同，不能套用本条。
