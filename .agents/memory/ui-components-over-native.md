# ui-components-over-native

**查证优先级：抽核**（依据 `packages/ui/src/index.ts` 的导出清单；新增组件后重核）

## 结论

前端控件**先 `@repo/ui`，不要直接上原生 HTML 控件**。裸 `<input type="date">` /
`type="datetime-local"` / `<select>` / `<input type="file">` 在深色模式、禁用态、清除、
下限约束上都是一套浏览器默认皮，和设计系统两套视觉，而且要自己处理格式与校验。

`@repo/ui` 里已经有的相关原语（别再造）：

| 需要什么 | 用什么 | 位置 |
| --- | --- | --- |
| 单个日期 + 时间 | **`DateTimePicker`** | `components/date-time-picker.tsx`（barrel 导出） |
| 日期区间（筛选） | `DateRangePicker` | `components/date-range-picker.tsx` |
| 日历面板（自定义组合） | `Calendar` | `components/ui/calendar.tsx`（**不进 barrel**，按路径引） |
| 弹层 | `Popover` | `components/ui/popover.tsx` |
| 下拉 | `Select` / `DictSelect` | barrel |
| 表单字段 | `ModalForm` / `DrawerForm` 的 `items`（`widget` 或 `render`） | `components/form.tsx` |

表单里遇到 `widget` 覆盖不到的类型（日期时间、自定义控件），用 `items[].render`
拿 `field.state.value` / `field.handleChange` 自己接线 —— **不要**为了图快给
`FormWidget` 加一个渲染原生 `<input>` 的分支。

## 依据

- `packages/ui/src/index.ts`：`export * from "#components/date-range-picker.tsx"`、
  `date-time-picker.tsx`；`components/ui/*` 里只有 `calendar.tsx` 没进 barrel
- 反例（2026-11-13）：分享弹窗的过期时间第一版用了 `<input type="datetime-local">`，
  被要求改成 `DateTimePicker`

## 失效信号

UI 包把日期/时间拆成别的组件名、或 `FormWidget` 新增了可覆盖日期的 widget 时重核。
