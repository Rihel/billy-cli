# 验证：接口自测（develop-backend-api 引用文件）

> 本文件是 `develop-backend-api` skill 的组成部分，由主 SKILL.md 引用。
> 接口交付前按本文件自测；响应格式细节见 [response-contract.md](./response-contract.md)。

1. `pnpm dev:pkgs` 先确保改动的包已构建；`pnpm dev:server` 起服务。
2. curl 自测主路径 + 错误路径，断言 body `code`（与 `AppErrorCodes` 一致）与 HTTP 状态：
   ```bash
   curl -s http://localhost:9989/xxx/create -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer <token>' -d '{"...":"..."}'
   ```
3. 抽查：连发两次同一写请求（幂等）；不存在 id（404 + code）；无权限 token（401 / 403）；
   非法参数（400）；size 超 100（400）。
4. 单元测试见 `write-tests` skill（错误断言：`AppError` 断 `{ code }`，HTTP 层 `ApiError` 断 `{ code, status }`）。
