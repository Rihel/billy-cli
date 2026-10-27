# 上下文压缩的现状

> **查证优先级：必核** —— 结论里全是行号、库里的记录和模型行，都是会漂的值。
> 用前先跑「核对命令」，任何一条对不上就现场改本卡。

## 结论

- 压缩**只在每轮开始前判定一次**：`chat.service.ts` 里两处 `if (built.needsCompaction && built.compactionRange)`（约 271–300 行、900–930 行），轮内工具往返不复查。
- 触发条件是「被裁掉的段非空」。当最近 3 轮保护覆盖全部历史时，`compactionRange` 为空，压缩无事可做；兜底只留系统提示词 + 最近 1 轮，仍超窗口就抛 `3307 ContextTooLong`。
- 本地库实查：`timelines` 里 `kind='summary'` 的记录为 **0 条** —— 压缩从未成功产出过摘要。
- `ai_models` 里 `deepseek-flash` 有**两行**：`source=sync` 的 `context_window=1048576`，`source=manual` 的为空。选中空的那行会落到 32000 兜底窗口。

## 核对命令

连接串从 `apps/server/.env` 的 `DB_URL` 取，直接在仓库根跑：

```bash
# 1) 压缩是否仍只在轮前判定一次（应看到 buildContext 调用点与 needsCompaction 分支）
grep -n "needsCompaction\|compactionRange" apps/server/src/modules/ai/runtime/chat.service.ts

# 2) 压缩有没有真的产出过摘要（结论 3，应为 0）
psql "$(sed -n 's/^DB_URL=//p' apps/server/.env)" -c "select count(*) from timelines where kind='summary'"

# 3) 模型窗口有没有空值 / 重复行（结论 4）
psql "$(sed -n 's/^DB_URL=//p' apps/server/.env)" -c "select model_key, context_window, source from ai_models"
```

## 依据

- `apps/server/src/modules/ai/runtime/context.service.ts:176` 读 `latestSummary`，`:148` 用 `fallbackWindow`
- `psql "$DB_URL" -c "select count(*) from timelines where kind='summary'"` → 0（2026-10-25）
- `psql "$DB_URL" -c "select model_key, context_window, source from ai_models"` → 两行 `deepseek-flash`（2026-10-25）

## 失效信号

- 压缩改成「每 N 步复查」或「按 token 预算保护」后，前两条不再成立。
- 清掉 `source=manual` 的重复模型行后，最后一条不再成立。
- `summary` 记录开始增长后，第三条要改写。
