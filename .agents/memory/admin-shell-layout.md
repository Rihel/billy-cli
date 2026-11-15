# admin 外壳：三棵树 + 一条共享顶栏

**查证优先级：必核**（路径与类名会随重构漂移，用前跑下面两条命令）

```bash
# ① 顶栏与分区判据还在不在
grep -n "TOP_BAR_HEIGHT\|APP_SECTIONS" apps/admin/src/components/AppTopBar.tsx
# ② 共享 Sidebar 的容器仍是 fixed（决定侧栏为什么要行内 top/height 下移）
grep -n "fixed inset-y-0" packages/ui/src/components/ui/sidebar.tsx
```

## 地图

| 树 | layout | 覆盖 | 有什么 |
| --- | --- | --- | --- |
| 管理 | `app/(app)/main/layout.tsx` | 除下面两棵之外的 `/main/**` | 顶栏 + 悬浮侧栏（`AppMenu`）+ `AppHeader`（h-11 标题）+ 内容 |
| 会话 | `app/(app)/(standalone)/main/layout.tsx` | `/main/ai/chat/**` | 顶栏 + `chat-type-scale` 工作台（自带会话列表 / 对话区） |
| 画布 | `app/(app)/(canvas)/main/layout.tsx` | `/main/ai/skills/[skillKey]` | 顶栏 + 全窗口编辑器 |

- 顶层分区只有两个：会话 / 管理。判据是纯函数 `apps/admin/src/lib/sections.ts`
  （`sectionOf` / `isChatPath`，前缀要带分隔符），顶栏 `components/AppTopBar.tsx` 消费它；
  单测 `apps/admin/test/app-sections.test.ts`。
- 三棵树**共用同一条顶栏**：品牌、主题、账号都在顶栏，侧栏只放模块菜单。
- 路由组不产生 URL 段，所以两棵树的地址仍是 `/main/...`；`proxy.ts` 的 matcher 不用动。

## 坑

- **共享 `Sidebar` 的容器是 `fixed inset-y-0 h-svh`**：顶栏横贯窗口上方后，它不会自己下移，
  会压在顶栏上。`AppSider` 用**行内 `style={{ top, height: calc(100svh - 顶栏高) }}`** 下移 ——
  别改成 `top-12` 之类的工具类：容器自带 `inset-y-0`，两个类谁覆盖谁取决于产物里的声明顺序。
- `SidebarProvider` 自带 `min-h-svh`：放在竖排 flex 里要传 `className="min-h-0 flex-1"`，
  否则整列比视口高、底部被裁。
- 会话页的 12px 字号基准（`chat-type-scale`）只包内容区，**不包顶栏**（顶栏跟管理台同一套字号）。

## 失效信号

- 共享 `Sidebar` 改成非 `fixed`（例如改用 grid/flow 布局）→ 上面「坑」的第 1 条与行内 style 都可删；
- 顶层分区增删 → 改 `APP_SECTIONS` + `lib/sections.ts` + 单测三处，`AppMenu` 里不要再放会话入口。
