# packages 布局：为什么不是「包太少」

**查证优先级：抽核**（包结构 / 消费者 / 构建耗时变动后重核；下方给了核对命令）

## 结论

- 5 个包按「运行时 + 依赖方向」分层：`shared`（纯 TS 契约与工具）→ `kits`（Node + Nest 基础设施）→
  `apps/server`；`ui`（React 组件）单独给两个 Next app；`http-client` → `sdk` 给前端调后端。
  **不是按功能域分的**，所以「包不够细」不是问题。
- 拆包买不到东西的三个原因（2026-11-13 实测）：
  1. **单消费者 / 无外部发布**：`kits` 只被 `apps/server` 用，`ui` 只被 web + admin 用，全部
     `workspace:*`（`Dockerfile.server` 用 `pnpm deploy --filter @app/server` 出镜像）。
     独立版本、独立发布这两个拆包主收益不存在；
  2. **构建与类型检查不是瓶颈**：`pnpm build:pkgs` 910ms（kits 374ms / sdk 130ms），
     全仓 `pnpm typecheck` 1.2s（TS 7 原生 tsgo，5 个工程）；
  3. **包内边界已经存在**：`kits` 16 个顶层目录 / 20 个 module 文件，跨顶层目录 import 只有
     redis 5、pubsub 2、lark 1，其余 45 处都指向 `foundation/` 底座；每个基础设施本就是
     provider + config + module + index 四件套。
- `ui` 的「大」已用**入口**治理而不是拆包：根 `index.ts` 只导出 61 个 shadcn 原语 + 35 个自有组件，
  48 个 ai-elements 与 chart / command / calendar 等重型组件刻意只走子路径（index.ts 注释
  「重型组件（按需引入）」），apps 里已有 21 处深路径导入；`components.json` 也钉在
  `packages/ui`（shadcn CLI 的 aliases / css / tsconfig 路径都指向这里）。
- 拆包在本仓有过一次实测代价：2026-09-17 拆 `@repo/design`（设计系统），`next build` 绿但两个 app
  dev 全 500（Turbopack 只对 `transpilePackages` 内的包解析 CSS 入口），当天回退并入 `ui`。
- 真实问题不是包数，而是**依赖卫生**：`kits` 的 `mysql2` / `node-cache` 零引用（`create-db.ts`
  固定 postgres）；`ui` 根入口把 markdown / data-table / form 这类常用件留在桶里是合理的。

## 失效信号（出现任一条再谈拆）

- 要对外发布某个包；出现本仓之外的消费者；某块依赖版本不可共存；某块要独立部署 / 独立授权；
  单包 build 或 typecheck 超过 ~10s。
- 真要拆时按代价从小到大：先做 `@repo/kits` 子路径 exports（不改 160 处 import 也能渐进）→
  再把可选基础设施（kafka / lark / notification / storage）合拆成**一个** `@repo/kits-integrations`，
  并用根包 re-export 兼容；**不要**一个基础设施一个包。

## 核对命令

```bash
pnpm build:pkgs && pnpm typecheck                      # 计时
grep -rn "@repo/kits/" apps packages --include='*.ts' | wc -l   # 0 = 全靠根入口
grep -rl "mysql2\|node-cache" packages/kits/src        # 无输出 = 死依赖仍在
grep -c "export \*" packages/ui/src/index.ts
```

依据：`docker/Dockerfile.server`（pnpm deploy）、`packages/ui/components.json`、
`docs/dev-logs/2026-09-17.md`（design 拆包回退）、`packages/kits/src/db/create-db.ts:29`。
