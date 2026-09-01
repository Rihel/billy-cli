# 字典与枚举详解（define-dict-enum 引用文件）

> 本文件是 `define-dict-enum` skill 的组成部分，由主 SKILL.md 引用。
> 定义字典 / 枚举时必读。

## 1. 字典是什么

字典 = 一组「key → `{ label, value, ... }`」的常量映射，前后端共用：后端错误映射、
前端下拉 / 标签展示。存放在 `packages/shared/src/dicts/*.dict.ts`，用 `createDict`
创建（实现见 `packages/shared/src/utils/dict.utils.ts`）。

动笔前先按「实现查找顺序」确认 `dict.utils.ts` 与 `dicts/` 既有字典已覆盖需求：
`createDictByDataSource`、`createTrueFalseOption`、`withAllOption` 等现成工具能覆盖
大多数场景，**不要重复实现字典工具**；新需求优先复用而非新增。

## 2. 两类字典

### 2.1 业务状态 / 类型字典（普通字典）

```ts
// packages/shared/src/dicts/user-status.dict.ts（参考现有实现，注意 key 大小写）
import { createDict } from '../utils'

export const UserStatus = createDict({
  Enabled: { label: '启用', value: 'enabled' },
  disabled: { label: '禁用', value: 'disabled' },   // 历史遗留小写 key，新代码统一 PascalCase
})
```

规则：
- key 用 **PascalCase**（`Enabled`）；value 小写字符串（`'enabled'`）；label 中文展示文案。
  （现有 `user-status.dict.ts` 里 `disabled` 是小写 key，属历史遗留，新字典统一 PascalCase，勿模仿。）
- value 全局唯一；`{ label, value }` 是约定结构（`createDict` 默认
  `labelKey: 'label'`、`valueKey: 'value'`），可附带额外字段（如 `i18n`）。
- 创建后在 `packages/shared/src/dicts/index.ts` 追加 `export * from './xxx.dict'`。

### 2.2 错误码字典（特殊字典）

```ts
// packages/shared/src/dicts/app-error-code.dict.ts（参考现有实现）
export const AppErrorCodes = createDict({
  TodoNotFound: { label: 'Todo 不存在', value: 3001, http: 404 },
  InvalidInput: { label: '参数校验失败', value: 4001, http: 400 },
  // ...
})
```

规则：
- value 为**数字分段**：`1xxx` 认证 / `2xxx` 用户、管理员 / `3xxx` 业务模块
  （每个新业务模块从这里起一段）/ `4xxx` 输入 / `5xxx` 系统。
- 必须带 `http` 字段（仅 400 / 401 / 403 / 404 / 409 / 500），
  `apps/server/src/lib/http.ts` 的 `describeErrorCode` 会自动映射为 HTTP 状态码与
  中文文案，**无需任何额外代码**。
- 业务层错误类引用它：`readonly code = AppErrorCodes.TodoNotFound`
  （见 `apps/server/src/modules/todo/errors.ts`）。

## 3. createDict 产物 API（前后端通用）

`const D = createDict({...})` 之后直接可用：

- `D.options` → `[{ label, value, ...源字段 }]`，可直接喂 Select / 下拉
- `D.values` / `D.labels`
- `D.getLabel(value)` → 中文文案；`D.getOption(value)` → 原条目；
  `D.getField(value, 'http')` → 取任意字段
- `D.isEnabled(value)`（自动生成 `is${Key}` 谓词，camelCase）
- `D.pickOptions([...])` / `D.omitOptions([...])` / `D.filterOptions(fn)`

辅助工具（`dict.utils.ts` 导出，均有实现，勿自写）：
- `withAllOption(D)` → 返回追加「全部 / all」选项后的新字典
- `createTrueFalseOption(trueOption?, falseOption?)` → 返回 `{ dict, allDict }`
  （是 / 否字典 + 含「全部」的版本），默认 `是=true` / `否=false`
- `createDictByDataSource(list, { labelKey, valueKey, all })` → 由数据行数组生成字典；
  `valueKey` 默认 `'id'`，`labelKey` 可为字符串或 `(item) => string` 函数，`all` 追加「全部」

## 4. 枚举 vs 字典（如何选择）

- **Zod enum**（`z.enum([...])`）：用于**请求 / 响应字段的强类型校验**，值域固定且
  需要服务端校验，典型是排序字段：
  ```ts
  // packages/shared/src/schema/todo.schema.ts（现有用法）
  orderBy: z.enum(['updatedAt', 'createdAt']).optional().default('updatedAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  ```
- **字典**：用于「需要 label 展示 / 前后端共享的常量映射」，如状态、类型、错误码。

惯例：DB 里的枚举字段用 **string 列存字典的 value**（不用 PG enum），实体默认值
直接引用字典值（见第 5 节）。

## 5. 实体与 schema 中如何使用字典值

```ts
// 实体（apps/server/src/database/entities/user-entity.ts 参考）
import { UserStatus } from '@repo/shared'

@Column({ name: 'status', default: UserStatus.Enabled, length: 20, comment: '用户状态' })
status: string
```

schema 中的值域校验，工程现状是**硬编码 `z.enum` 字符串数组**（与字典并存）：

```ts
// packages/shared/src/schema/admin.schema.ts（现有用法）
export const AdminStatusSchema = z.enum(['enabled', 'disabled'])
```

- 现状：`admin.schema.ts` 用 `AdminStatusSchema = z.enum(['enabled', 'disabled'])`
  硬编码，未从 `UserStatus.values` 构造；`user.schema.ts` 未暴露 status 字段。
- 若需从字典构造（可选替代）：`z.enum(UserStatus.values as [string, ...string[]])`；
  纯映射字段也可只做 `z.string()`，值域校验交给业务层。**新代码遵循现状（硬编码
  z.enum）或显式引用字典，二者择一并保持一致。**

## 6. 前端展示

- admin 端标签：`<DictTag dict={UserStatus} value={record.status} />`
  （`@repo/ui` 的 `components/display.tsx` 内 `DictTag`）；普通文本取 label 用
  `UserStatus.getLabel(value)`。
- 下拉选项直接用 `UserStatus.options`，需要「全部」时用 `withAllOption(UserStatus)`。
