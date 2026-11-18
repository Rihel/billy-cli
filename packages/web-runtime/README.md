# @repo/web-runtime

联网工具的可复用运行时：**出网 / SSRF 校验 / HTML→Markdown / 按行分页 / 反爬识别**。

server 的 `web-fetch` / `web-request` 与 common-capability 的 `web-fetch` 共用这一份，避免两套 UA、超时、
内网拦截和分页口径各自漂移。

## 导出

- `fetchGuarded` / `browserHeaders` / `BROWSER_UA` / `WebToolError`
- `searchWeb` / `SearchToolError`（DeepSeek 搜索客户端）
- `htmlToMarkdown` / `htmlToPlainText` / `extractTitle` / `detectAntiBot`
- `WebCache` / `splitPages` / `makeRef` / `pageOf` / `footerOf`
- `SITE_FALLBACKS`

## 约定

- 这是**纯运行时**，不依赖 Nest / DB / 会话；错误用 `WebToolError`（`reason` / `hint` / `retryable`），
  调用方自己翻成 `ToolOutcome`。
- 出网只走 `http.ts` 一处；不要在业务工具里直接 `fetch`。
- `allowPrivateNetwork` 默认 false；本地联调才打开，生产靠出口代理收紧。
