# ui-data-table-column-id

**查证优先级：抽核**（依据 TanStack Table 9 的 key 推导；升级 Table 大版本或改 DataTable 后重核）

## 结论

`DataTable` 直接用表格 id 当 React key：表头 `key={header.id}`、单元格 `key={cell.id}`，
而 `cell.id = ${row.id}_${column.id}`。因此**同一个 columns 数组里两列不能共用同一个
`accessorKey`**（或同一个 `id`）——否则控制台刷屏
"Encountered two children with the same key, `xxx_config`"（每行一条 + 表头一条），
列可见性 / `getColumn()` 也会错乱。

## 做法

派生列别复用源字段：给列显式 `id` + `accessorFn`，cell 照旧读 `row.original`。
例：`apps/admin/src/app/main/monitor/rules/page.tsx` 的「级别」「阈值」原来都用
`accessorKey: 'config'`，改成 `id: 'level' | 'threshold'` + `accessorFn`。

注意：同一文件里**两张不同表**各有 `enabled` 列是正常的（如 `ai/models/page.tsx`），
判定范围是单个 columns 数组。

## 依据

- `packages/ui/src/components/data-table.tsx`：`key={header.id}` / `key={cell.id}`
- `@tanstack/table-core` `core/cells/constructCell.js`：`cell.id = \`${row.id}_${column.id}\``

## 失效信号

DataTable 改用列下标 / 稳定 hash 生成 key，或 TanStack 改变列 id 推导规则时，本卡不再成立。
