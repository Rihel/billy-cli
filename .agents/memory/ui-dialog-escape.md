# ui-dialog-escape

**查证优先级：必核**（核对命令见文末；升级 `@base-ui/react` 后重核）

## 结论

`@base-ui/react` 的 Dialog **没有** Radix 那种 `onEscapeKeyDown`（`DialogPopup` / `DialogRoot` 的 props 里都没有）。
要在「按 Esc 时先别关窗、做点别的事」，只有一条路：

在 `<Dialog>` 的 `onOpenChange(open, details)` 里判断 `details.reason === 'escape-key'`，
调 `details.cancel()`（阻止 Base UI 继续走关闭流程），再做自己的动作。

- 取消语义是 `applyPopupOpenChange` 先调 `onOpenChange`，随后 `if (eventDetails.isCanceled) return`；
- 全屏预览的用法：`FilePreviewDialog` 全屏态 Esc 只退全屏、再按一次才关窗
  （`apps/admin/src/components/file-preview-dialog.tsx`）；
- 分享页没有弹窗，Esc 直接交给 `useHotkeys('escape')`（`share-preview.tsx`）。

## 依据

- `dialog/popup/DialogPopup.d.ts`：只有 `initialFocus` / `finalFocus`，无 Esc 钩子；
- `dialog/root/DialogRoot.d.ts`：`onOpenChange(open, eventDetails)`；
- `internals/reason-parts.js`：`escapeKey === 'escape-key'`；
- `utils/popups/popupStoreUtils.js` 的 `applyPopupOpenChange`：`onOpenChange` 之后检查 `eventDetails.isCanceled`。

核对：

```bash
grep -rn "escapeKey = exports.escapeKey" node_modules/.pnpm/@base-ui+react@*/node_modules/@base-ui/react/internals/reason-parts.js
grep -n "isCanceled" node_modules/.pnpm/@base-ui+react@*/node_modules/@base-ui/react/utils/popups/popupStoreUtils.js
```

## 失效信号

`@base-ui/react` 给 Dialog 补了专用 Esc 回调（如 `onEscapeKeyDown`），或 `cancel()` 语义变化时改用新 API。
