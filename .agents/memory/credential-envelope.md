# 个人凭据：信封加密、字段模板与表

**查证优先级：必核**（改凭据加密 / 模板 / 注入前复核）

## 结论（2026-11-20，P2 落地）

- **密文信封**：`packages/kits` 的 `EnvelopeCipher`，格式 `v1:<keyId>:<iv>:<tag>:<ct>`（AES-256-GCM，
  IV 12 字节随机）。**AAD 必须传该行身份**：`credentialAadOf()` 生成
  `${id}|${ownerType}:${ownerId}|${provider}|${template}` —— 目的是防"把 A 行密文写进 B 行"。
  参与 AAD 的字段写入后不可改，改了必须重新加密。
- **密钥环**：环境变量 `PERSONAL_CREDENTIAL_KEYS`（`v1:<base64>,v2:<base64>`）或单把简写
  `PERSONAL_CREDENTIAL_KEY`；`PERSONAL_CREDENTIAL_KEY_CURRENT` 指定写用哪把；解密永远按密文自带 keyId。
  32 字节不对 → 启动即失败；一把都没配 → 可启动但写入报错（不落明文）。
- **模板驱动一切**：`packages/shared/src/credential/templates.ts` 的模板是唯一事实源（6 份 / 5 个 provider：
  lark 另有 `key: 'lark-app'` 的自建应用 AK/SK 模板，注入 `~/.lark-cli/config.json`），
  `scope=config` 进明文列、`scope=secret` 进密文；校验 / 拆分 / `secret_hint` 全由模板派生，
  **代码里不写具体字段名**。加一种资源只加模板。
- **表**：`personal_credentials`（`packages/db/src/entities/personal-credential-entity.ts`），
  唯一键 `(owner_type, owner_id, name) WHERE deleted_at IS NULL`，到期索引只扫
  `lifetime='temporary'` 的活行。吊销 = 软删 + `status='revoked'`（保留行便于追溯）。
- **明文纪律**：明文只在单次函数调用内驻留；不进日志 / 异常 / 序列化输出；绑定接口请求体不进请求日志。
- **管理面**：`/ai-credential/{list,detail,create,update-inject,remove}`（管理员鉴权），
  service 对外模型来自 `toModel`，**结构里没有 secretEnc**；解密只走 `PersonalCredentialService.reveal()`
  （仅供平台内部消费方，不经 HTTP）。归属一律 `currentOwner()` + `scopeOf()`。
- **覆盖要先确认**：同名绑定直接报 3403，不做静默替换（Q3）。
- **解析与刷新**：`POST /internal/credentials/resolve`（`x-internal-token` = `TOOL_INTERNAL_TOKEN`），
  入参带**目标归属主体**而非登录人；`CredentialResolveService` 到期前 15 分钟刷新、按 owner 串行锁
  （`credential:refresh:<ownerType>:<ownerId>`）、锁内二次查询；`invalid_grant` 置 expired，
  网络故障只记审计不降级；运行时以 `expires_at` 为准（status=active 但过期也算不可用）。
- **变更同步（P6）**：凭据行 `version` 列（绑定=1、刷新 +1），主体级 `credentialVersion` =
  `credentialVersionOf`（活跃条数-最大 version），main 与执行面同一函数；
  `CredentialSyncService` 按 owner 查候选 → 查实时状态（只查不起）→ 只推运行中的 →
  失败重试（吊销 5 次、其余 3 次）；执行面 `POST /v1/workspaces/sync` 不 start、只重落凭据。
  **坑**：别用 `updated_at` 当版本 —— 解析时 `touch last_used_at` 会顶高它，永远不收敛。
  workspace-service 调 main `/internal/*` 必须用 `TOOL_INTERNAL_TOKEN`（不是 `WORKSPACE_INTERNAL_TOKEN`）。
- **执行前检查（P7）**：`apps/workspace-service/src/workspace/credential-gate.ts` 的
  `CREDENTIAL_COMMANDS`（lark / gh / mysql / redis-cli / tccli）+ `checkCommandCredentials`；
  清单来自 `.billy/credentials.json`（初始化/同步后缓存在 handle 上），命中缺凭据 → `missing-credential`。
  **零 RPC**：拒绝策略不受控制面可用性影响。P8 把命令表移进完整 CLI 适配器。
- **导入后校验（P8 补）**：适配器可选 `status`（gh = `gh auth status`），导入成功后跑一次，
  结果以 `verified` 返回；无 status 的适配器不带该字段，失败只告警不回滚。
- **从工作区导入（P8）**：`workspace-service/src/workspace/cli-adapters.ts`（github=命令 `gh auth token`；
  mysql/redis/tencent-cloud/lark 无 importFrom）+ `credential-import.service.ts` 读→解析→调 main
  `POST /internal/credentials/import`（`importForOwner`，显式主体）。模型只传 provider；
  适配器 key 必须等于**模板 provider**（如 `github` 而不是 `gh`），否则清单里的 provider 对不上。
  **lark 永不进候选**：真实 CLI 把 token/appSecret 加密存在 `~/.local/share/lark-cli/`（master.key + *.enc），
  配置在 `~/.lark-cli/config.json` 且不含 token，没有任何明文导出命令 —— 以前声明的
  `~/.config/lark-cli/config.json $.token` 是虚构路径，已删。
- **保存用户给的值**：`credential-save`（workspace-service，`credential-save.executor.ts` + `credential-save.service.ts`）
  收 provider / template / name / values → 同一个 main 内部导入接口；与 import 互补（import 的值不经过模型）。
- **失败原因必须透传**：workspace 的 `credential-main.client.ts` 非 2xx 时读响应体 message 拼进错误；
  main 的模板校验错误带字段键名（`appId：请填写应用 ID`）—— 模型只能靠错误文案自纠。
- **飞书刷新适配器（P11）**：`lark-oauth.refresh.ts`（`LARK_APP_ID/SECRET` 存在才注册），
  调 `authen/v2/oauth/token`；`invalid_grant`/`invalid_token`/401 → Rejected（置 expired），
  5xx/网络错误原样抛（不降级），无 refreshToken 直接 Rejected。
- **审计**：`personal_credential_audits`，动作 issue/refresh/resolve/deny/revoke，只追加、不含值；
  `detail` 放 name/provider/outcome。

## 依据

- `docs/design/workspace-cli-credentials.md` §6.4.1 / §6.4.1.1 / §6.4.2
- `packages/kits/src/crypto/{envelope-cipher,keyring}.ts`、`packages/shared/src/credential/**`
- 核对：
  ```bash
  pnpm --filter @repo/kits exec vitest run test/envelope-cipher.test.ts
  pnpm --filter @repo/shared exec vitest run test/credential-template.test.ts
  PGPASSWORD=pg1234 psql -h localhost -U root -d billy-cli -c "\d personal_credentials"
  pnpm --filter @app/main exec vitest run test/credential-resolve.test.ts
  curl -s -X POST http://127.0.0.1:9989/internal/credentials/resolve -H 'x-internal-token: dev-tool-token' \
    -H 'content-type: application/json' -d '{"ownerType":"user","ownerId":"u1","names":["x"],"consumer":"web"}'
  ```

## 失效信号

改密文格式（必须升 `v1` 前缀并兼容旧文）；AAD 组成变化；模板改成后台数据；密钥改从 KMS 取
（替换"按 keyId 取密钥"的实现即可，表结构不变）。
