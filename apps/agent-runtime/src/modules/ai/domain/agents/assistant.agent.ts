import { TOOL_KEYS } from '../../tools/engine/tool-keys.js'
import { ALL_TOOLS } from '../../tools/engine/tools.types.js'
import { ALL_SKILLS } from '../../tools/skills/skills.types.js'
import type { AgentSpec } from './types.js'

/**
 * 默认 agent：通用助手（任务清单、子助手、联网、执行命令、文件操作）。
 *
 * **它是「能力上限」的示例，不是产品形态**：工具面写 `ALL_TOOLS`（全部可见工具），
 * 运行期再按「本地注册机的编排工具 + 能力目录里的内部服务能力」拼出来。
 * 使用方定义自己的 agent 时应按职责裁剪（`docs/guide/ai.md` 的「定义自己的 agent」、
 * skill `develop-ai-agent/references/define-agent.md`）。
 *
 * 权限只写 key / `'*'`，不再区分「内外部」：
 * - 运行时编排能力（规划四个、`run-sub-agent`、技能库）在本进程注册机里；
 * - `bash` / 联网 / 文件 / 记忆 / 取页这些是**服务侧能力**，由能力目录下发；
 * - MCP / 外部登记服务**不随工具面下发**，模型需要时自己用 `tool-search` 找，
 *   搜到后下一轮才可调用（见 `core/tools/tool-discovery.store.ts`）。
 *
 * `run-sub-agent` 是**委派类工具**：给出去之后，这个 agent 就能为一件事临时造一个专职子助手
 * （子助手的提示词由它现写、工具面是"全部 − 委派类"）——见设计文档 §3.14。
 * 子助手不是注册表成员，所以这里不需要声明任何"子 agent 名单"。
 */
export const assistantAgent: AgentSpec = {
  key: 'assistant',
  name: '通用助手',
  description:
    '日常问答 + 任务清单（创建 / 重排 / 完成 / 删除）+ 联网查资料（搜索 / 抓网页 / 调接口）+ 可临时创建子助手 + 可执行本机命令（默认关闭，仅自用部署显式开启）+ 长任务轮询 / 取消（wait-task / cancel-task）',
  tools: [
    // 工具面按授权清单展开，运行期再按调用身份过滤
    ALL_TOOLS,
    TOOL_KEYS.planCreate,
    TOOL_KEYS.planReorder,
    TOOL_KEYS.planComplete,
    TOOL_KEYS.planDelete,
    TOOL_KEYS.runSubAgent,
    TOOL_KEYS.subAgentList,
    TOOL_KEYS.waitSubAgent,
    TOOL_KEYS.cancelSubAgent,
  ],
  /**
   * 技能：**全部已加载技能**（`core/skills/catalog/` + `AGENT_SKILLS_DIRS` 配置的目录）。
   *
   * 为什么给全部而不是挑几个：技能是**渐进披露**的 —— 提示词里只放"名字 + 什么时候用"，
   * 正文与参考文件由 `skill` / `skill_read` 工具按需取。所以多装几个的成本是目录里多几行字，
   * 不会把上下文撑爆；真要用时模型自己挑。
   *
   * 要收紧成白名单时，把这里换成具体名字数组即可（未知名字装配期就报错）。
   */
  skills: [ALL_SKILLS],
  prompt: { template: 'assistant' },
}
