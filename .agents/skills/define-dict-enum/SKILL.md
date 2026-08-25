---
name: define-dict-enum
description: 在 Billy 工程中定义「字典」与「枚举」：新增或修改错误码、状态、类型、下拉选项等 label/value 映射，并正确接入实体、schema 与前端展示。触发词：定义字典、枚举、错误码、状态、类型、下拉选项、Dict、createDict、AppErrorCodes、isXxx。
---

# 定义字典、枚举

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条）。

## 核心要点

- 字典 = `key → { label, value, ... }` 常量映射，放 `packages/shared/src/dicts/*.dict.ts`，
  用 `createDict` 创建；注册到 `dicts/index.ts`。
- 错误码字典 `AppErrorCodes` 数字分段：`1xxx` 认证 / `2xxx` 用户、管理员 / `3xxx` 业务
  模块 / `4xxx` 输入 / `5xxx` 系统，且每条带 `http` 字段（边界自动映射）。
- DB 枚举字段用 **string 列存字典 value**（不用 PG enum），实体默认值引用字典值。
- 值域校验用 `z.enum`；展示映射用字典（label / options / getLabel）。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/dict-guide.md](./references/dict-guide.md) | 两类字典、createDict API、辅助工具、枚举选择、实体 / schema / 前端接入 | 定义字典 / 枚举时（必读） |

## 完成检查清单

- [ ] 已按「实现查找顺序」确认 `dict.utils.ts` 与 `dicts/` 既有字典未覆盖需求（不重复造轮子）
- [ ] 新字典文件已 `export` 到 `packages/shared/src/dicts/index.ts`
- [ ] key 用 PascalCase；value 全局唯一；错误码数值不与其他段冲突且 `http` 合法
- [ ] 实体列默认值 / schema 校验 / 前端展示三处 value 一致
- [ ] 若新增错误码：core 对应错误类已引用它，前端不再硬编码错误文案
