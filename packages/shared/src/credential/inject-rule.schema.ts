import { z } from 'zod'
import type { CredentialInjectRule } from './credential-template.types'

/**
 * 注入规则的结构校验（§6.4.3）。
 *
 * - `file`：写入容器内某个配置文件，`template` 里用 `${secret.x}` / `${config.x}` 引用字段；
 * - `env`：写成环境变量，`field` 指定取哪个字段（单字段凭据可省略）。
 *
 * 这两个形状同时用于：绑定入参、"修改映射"接口、模板里的默认注入规则。
 */
export const CredentialInjectRuleSchema: z.ZodType<CredentialInjectRule> = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal('file'),
      path: z
        .string()
        .min(1, '文件路径不能为空')
        .max(512, '文件路径过长')
        .describe('容器内路径，支持 ~/ 前缀'),
      template: z.string().min(1, '文件模板不能为空').max(8192, '文件模板过长'),
    }),
    z.object({
      type: z.literal('env'),
      name: z
        .string()
        .regex(
          /^[A-Za-z_][A-Za-z0-9_]*$/,
          '环境变量名只能包含字母、数字、下划线，且不能以数字开头',
        ),
      field: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('取哪个凭据字段；省略则取唯一的 secret 字段'),
    }),
  ],
)
