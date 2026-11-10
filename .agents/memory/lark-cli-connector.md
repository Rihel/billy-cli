# lark-cli 连接器（飞书 CLI）

**查证优先级：抽核** —— npm 包与 CLI 参数会漂移；动 `lark-cli` 相关代码前先核一次。

## 结论

- `@larksuite/cli` 的 npm 包只是 launcher：postinstall 下载 Go 静态二进制到
  `node_modules/@larksuite/cli/bin/lark-cli`；Alpine 可直接跑（static ELF），需要 `curl` + `tar`。
- 技能内嵌在二进制里：`lark-cli skills list`（2026-11-09 实测 28 份）、`skills read <name>`；
  不必 `npx skills add`，也不必写进 `AGENTS_SKILLS_DIRS`（省系统提示词）。
- 配置在 `$HOME/.lark-cli/config.json`，secret 另存（macOS `~/Library/Application Support/lark-cli/`，
  Linux `~/.local/share/lark-cli/` 的 `master.key` + `appsecret_*.enc`；两处实测）。**按实例改 `HOME` 隔离**。
- `config init --app-id X --app-secret-stdin --brand feishu --force-init`：先落盘再校验；
  凭证错也保存、退出码非 0（驱动记指纹，避免每次重跑）。
- `whoami` 在假凭证下也报 `identity: ready`，不能探活；`doctor` 才真校验（exit 1 + `identity_ready: fail`）。
- `auth login` 默认阻塞；agent 用 `--no-wait --json` 拿链接，再 `--device-code <code>` 收尾。
- CLI 是 Node wrapper + Go 二进制：只杀 wrapper 会留 Go 孤儿；用 `spawn({detached:true})` 按负 pid
  杀进程组（Windows 退回只杀 wrapper）。
- 命令面别放 `api` / `config` / `profile` / `update` / `apps` / `event`；白名单见
  `connectors/drivers/lark-cli.policy.ts`。
- **无状态 pod**：HOME 是临时的；配置与用户 token 存 `ai_connectors.auth_state`（`{相对路径:base64}`）
  + `auth_state_version`，驱动调用前 hydrate、调用后 diff 写回（CAS），整次调用持实例级 Redis 锁
  `connector:lark:<id>`；删连接器 `dispose` 清库 + 删 HOME。

## 依据

`connectors/drivers/lark-cli.driver.ts`、`.policy.ts`、`lark-cli.home.ts`、`connector-state.store.ts`；
2026-11-09 用 `@larksuite/cli@1.0.99` 实测：macOS arm64、node:24-alpine（Linux）、linux-amd64 为 static ELF。

## 失效信号

- npm 包改安装脚本 / 不再内置 skills；`config init` 或 `doctor` 输出结构变化；
- 升级 `LARK_CLI_VERSION` 后先跑 `lark-cli --help`、`skills list`、`doctor` 各一次。

## 核对命令

`npm view @larksuite/cli version --registry=https://registry.npmjs.org`、`lark-cli --version`、
`lark-cli skills list | head`、`psql -c "select auth_state_version, auth_state is not null from ai_connectors"`
