# 定义自己的 agent（裁剪与授权）

> 本文件是 `develop-ai-agent` skill 的组成部分：讲**怎么想**（职责 → 工具面 → 授权三层）。
> 「写到哪个文件、代码样例、命令」在 [`docs/guide/ai.md`](../../../../docs/guide/ai.md) 的「定义自己的 agent」；
> 工具怎么实现见 `SKILL.md` §2.1；连接器怎么接见 [connector.md](./connector.md)。

## 0. 先分清三件事

| 想做的事 | 该加什么 | 不该加什么 |
| --- | --- | --- |
| 多一种业务动作（查订单、记一笔） | **业务工具**（`@ToolDecl`）+ 给 agent 授权 | 新 agent |
| agent 多一条"什么时候用、怎么用"的手艺 | **技能**（`SKILL.md`） | 工具 |
| 换一种角色：职责、工具面、提示词都不同 | **新 agent**（`AgentSpec`） | 往示例 agent 上加工具 |

判断句：**工具回答"能不能做"，技能回答"怎么做"，agent 回答"是谁、负责到哪"**。
只多一个动作就别新建 agent —— 每多一个 agent 就多一份提示词、工具面和要维护的边界。

## 1. 从职责倒推工具面

先写一句话职责，再问「这句话里的每件事，需要哪个工具」：

```
"帮用户跟进事项：记进展、汇总卡点、生成交接说明"
  → 读：item-query / item-summary
  → 写：item-draft-action（草案）+ item-append-action（确认后写）
  → 不需要：run-command、web-*、plan-*、连接器
```

三条切口：

- **不给万能工具**：`run-command` 只给运维 / 开发类 agent；`'*'` 只给示例 agent；
- **写工具要有确认**：append-only / 有副作用的能力，优先"草案 + 用户确认"，不要让模型直接落库；
- **技能跟着职责走**：`skills: [ALL_SKILLS]` 只适合示例；产品 agent 只给它用得到的那几份，
  技能目录每多一份，系统提示词就多几行。

## 2. 授权清单的写法

`AgentSpec.tools` 支持四形态（结构化选择器，不走字符串解析）：

```ts
tools: [
  TOOL_KEYS.planCreate,                    // 具体 key（写错启动期报错）
  { category: 'business' },                // 某一类
  { connector: 'prod-pg' },                // 某个连接器产出的全部工具
  { connector: 'prod-pg', tool: 'query' }, // 精确到接入方的一个工具
]
```

`'*'`（`ALL_TOOLS`）等价于"全部"，**只给内置示例 agent**。

口径：

- **具体 key 必须存在**：装配期 `describe()` 会抛，不会拖到用户提问时；
- **连接器选择器允许零命中**：连接器是运行期同步的，启动时没同步不是错误；
- **不做 key 反解**：`{ connector: 'x', tool: 'y' }` 匹配的是 spec 上的 `connector.toolName`
  （接入方原名），不是拼出来的 key 尾巴。

## 3. 授权是三层，不是一层

```
① AgentSpec.tools（代码）     这个 agent 有没有资格看到
   └ ② ai_tools.scope / allowedAgents（库）  这次调用身份能不能用（装配期过滤 + 调用期兜底）
        └ ③ 提示词（模板）   什么时候用 / 不用
```

- **① 是上限**：不在清单里的工具，模型根本看不见；子 agent 的工具面 = 父授权 ∩（全部 − 委派类 − `child: deny`）。
- **② 是第二层**：连接器工具默认 `admin`；产品 agent 要用，改成 `agent` + `allowedAgents`（或 `all`）。
  装配期按 `isAdmin` / `rootAgentKey` 过滤，前台用户不会看到管理员工具。
- **③ 只解释**：提示词里写"不要用某工具"没有约束力，**从授权里去掉**才是约束。

## 4. 反模式

| 反模式 | 后果 | 正确做法 |
| --- | --- | --- |
| 复制内置示例 agent，工具面留 `'*'` | 产品 agent 又变成万能助手 | 按职责列清单，默认不给 |
| 在提示词里写"不要执行命令" | 模型照样调，只是偶尔被拒 | 授权里去掉 `run-command` |
| 给连接器工具不改 scope | 产品 agent 拿到了却每次被拒 | 改 `agent` + `allowedAgents` |
| 每个小功能建一个 agent | 前端选择器一堆，提示词各写一遍 | 同一角色加工具 / 加技能 |
| 把工具名手写进提示词模板 | 授权一改，提示词就骗模型 | 用 `registry.describe()` 渲染 |

## 5. 验收清单

- [ ] 启动不报错（未知 key、未知类别、非法连接器 key 都在装配期炸）；
- [ ] `POST /agent/list` 里这个 agent 的工具数与预期一致；
- [ ] 跑一轮后审计 `request_snapshot.toolKeys` 是**展开后的具体 key**；
- [ ] 用管理员与前台用户各跑一次，确认作用域过滤生效（该看不见的看不见）；
- [ ] 子 agent 场景：确认子助手拿不到委派类 / `child: deny` / 父 agent 没授权的工具。
