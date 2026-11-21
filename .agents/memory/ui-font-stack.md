# 字体：纯系统栈，不再拉 Google Fonts

> **查证优先级：必核** —— 改字体栈 / layout 字体接线 / 新增 app 时重核。

## 结论（2026-11-21）

- **决策**：`@repo/ui` 的 `--font-sans` / `--font-mono` 用系统字体栈
  （`system-ui` / `ui-monospace` + PingFang / 雅黑），`--font-display` 派生自 `--font-sans`；
  三个根 layout（admin `(app)`、admin `(share)`、web）**都不接 `next/font`**。
- **为什么**：原先从 Google Fonts 下 Geist / Geist Mono / Space Grotesk —— 内网 / 离线构建与首屏
  依赖外网；且会话页 12px 阶梯是按中文定的，Geist 字面比 PingFang 饱满，同一 px 西文显大一圈
  （工具卡长命令最明显）。系统 UI 字体与中文天然同档。
- **代价**：放弃品牌化西文字形；标题层次改由字号 / 字重承担。
- **守卫**：`pnpm check:ui` ⑤ 拦 root layout 里的 `next/font/google`；
  `packages/ui/test/tokens.test.ts` ⑥ 断言系统栈且不含 `--font-geist`。
- 曾试过「Geist latin 子集 + `size-adjust:92%`」的拉丁缩放方案，随本次决策一并撤掉（字体文件已删）。

## 依据

- `packages/ui/src/globals.css`（`@theme inline` 里的 `--font-*`、`:root` 的 `--font-display`）
- `docs/design/design-system.md` §4.1 / §4.1.1
- 核对：
  ```bash
  grep -n "font-sans:\|font-mono:\|font-display:" packages/ui/src/globals.css
  grep -rn "next/font" apps/*/src/app --include=layout.tsx   # 应为空
  pnpm check:ui && pnpm --filter @repo/ui exec vitest run test/tokens.test.ts
  ```

## 失效信号

重新引入品牌字体（应走 `next/font/local` 自带文件、不依赖外网，并恢复 `check:ui` 字面量校验）；
某台机器上系统字体缺失导致回退链变化（Linux 无 PingFang 时落到雅黑 / 通用 sans）。
