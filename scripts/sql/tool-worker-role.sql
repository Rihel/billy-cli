-- tool-worker 的最小 DB 权限（PostgreSQL）
--
-- 用法（本地 / 生产由 DBA 执行，密码自己换）：
--   psql "$DB_URL" -v worker_password='...' -f scripts/sql/tool-worker-role.sql
--
-- worker 只需要：
--   ai_memories  读写（memory-*）
--   ai_files     读写（file-*）
--   timelines    只读（read-tool-result 的 timeline 兜底）
--   conversations 只读（file 的会话归属 / workspace id 校验）
-- 不授予 ai_skills / ai_tools / runs 写权限；skill-* 由 server 控制面执行。

CREATE ROLE billy_tool_worker LOGIN PASSWORD :'worker_password';

GRANT USAGE ON SCHEMA public TO billy_tool_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.ai_memories,
  public.ai_files
TO billy_tool_worker;

GRANT SELECT ON public.timelines, public.conversations TO billy_tool_worker;

-- 未来迁移新增列 / 表时，按同样的最小面显式授权，不要 GRANT ALL。
