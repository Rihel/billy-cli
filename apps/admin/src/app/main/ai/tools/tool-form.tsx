'use client'

import dedent from 'dedent'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useForm } from '@tanstack/react-form'
import { useStore } from '@tanstack/react-store'
import { ToolCategory, ToolScope } from '@repo/shared'
import type { AiToolModel, AiToolUpdateDto } from '@repo/shared'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ConfirmAction,
  DictSelect,
  DictTag,
  Input,
  ModalForm,
  SegmentedControl,
  Switch,
  Tag,
  TagsInput,
  toastError,
  toastWarning,
  cn,
  Label,
} from '@repo/ui'
import {
  ChevronDownIcon,
  KeyRoundIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { ToolConfigPanel } from './config-panels'
import { ToolEventsPanel } from './tool-events'
import { buildToolUpdatePayload, toFormValues } from './tool-payload'
import type { ToolFormValues } from './tool-payload'

/**
 * 工具配置编辑弹窗。
 *
 * 分三块，对应三类信息：
 * 1. **只读区** —— 来自代码声明与运行期快照，后台改不了（key / 类别 / 入参定义 / 哪些 agent 用它）；
 * 2. **治理区** —— 开关、作用域、`allowedAgents`、限额（`ai_tools` 表里那一行）；
 * 3. **工具区** —— 工具专属配置（一期按 key 手写面板）与秘钥。
 *
 * 保存只提交改动过的字段（省略 = 不改，见 `tool-payload.ts`）；秘钥留空 = 不改、
 * 勾选「清空」= 提交空串。请求与列表刷新由宿主负责（本组件只管取值与校验）。
 */

export type ToolFormModalProps = {
  /** 正在编辑的工具（null = 没有选中） */
  tool: AiToolModel | null
  open: boolean
  /** 保存：宿主发 `update` + 刷新列表 + toast */
  onSave: (dto: AiToolUpdateDto) => Promise<void>
  /** 恢复默认：宿主发 `reset` + 刷新列表 + toast */
  onReset: (tool: AiToolModel) => Promise<void>
  /** 保存中（宿主 mutation 的 pending 状态） */
  saving: boolean
  onClose: () => void
}

/** 表单空白初值（打开弹窗时用选中的工具覆盖） */
const EMPTY_VALUES: ToolFormValues = {
  enabled: true,
  scope: 'all',
  allowedAgents: [],
  config: {},
  secrets: {},
  clearSecrets: {},
}

/** 分组容器：标题 + 说明 + 内容（弹窗内的分区视觉） */
const FormSection = ({
  title,
  description,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
}) => (
  <section className="flex flex-col gap-3 rounded-lg bg-surface-1 p-4">
    <div className="flex flex-col gap-0.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
    {children}
  </section>
)

/** 只读项：标签在上、值在下，`span` 为 2 时占满整行 */
const ReadonlyItem = ({
  label,
  span = 1,
  children,
}: {
  label: ReactNode
  span?: 1 | 2
  children: ReactNode
}) => (
  <div className={cn('flex flex-col gap-1', span === 2 && 'sm:col-span-2')}>
    <span className="text-xs text-muted-foreground">{label}</span>
    <div className="text-sm">{children}</div>
  </div>
)

/** 数字输入（留空 = 不限制） */
const NumberField = ({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value?: number
  onChange: (next: number | undefined) => void
}) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-sm font-medium">{label}</span>
    <Input
      type="number"
      value={value === undefined ? '' : String(value)}
      placeholder="留空 = 不限制"
      onChange={(event) =>
        onChange(event.target.value === '' ? undefined : Number(event.target.value))
      }
    />
    <span className="text-xs text-muted-foreground">{hint}</span>
  </div>
)

/** 入参定义（`paramSchema`）折叠展示：只读，便于核对"模型看到的入参长什么样" */
const ParamSchemaBlock = ({ schema }: { schema: Record<string, unknown> | null }) => {
  const [open, setOpen] = useState(false)
  if (!schema) {
    return <span className="text-xs text-muted-foreground">该工具没有声明参数定义</span>
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronDownIcon className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        {open ? '收起 JSON' : '展开 JSON'}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-surface-1 p-3 font-mono text-xs">
          {JSON.stringify(schema, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ToolFormModal({
  tool,
  open,
  onSave,
  onReset,
  saving,
  onClose,
}: ToolFormModalProps) {
  const [submitError, setSubmitError] = useState<string>()

  const form = useForm({
    defaultValues: EMPTY_VALUES,
    onSubmit: async ({ value }) => {
      if (!tool) return
      const built = buildToolUpdatePayload(tool, value)
      if (!built.ok) {
        // 表单内联提示 + toast 各一份：弹窗内容区会滚动，只放顶部可能被滚过去看不到
        setSubmitError(built.error)
        toastError('还不能保存', built.error)
        return
      }
      if (!built.dto) {
        toastWarning('没有检测到改动，未提交')
        return
      }
      await onSave(built.dto)
      onClose()
    },
  })
  const values = useStore(form.store, (state) => state.values)

  // 打开弹窗时回填：弹窗常驻挂载，靠这一步把表单重置成选中工具的值。
  // 依赖里带上 `open`：同一个工具关掉再打开（data 还是同一个对象引用）也要回到库里的值，
  // 不能留着上一次没保存的编辑。
  useEffect(() => {
    if (!open || !tool) return
    form.reset(toFormValues(tool))
    setSubmitError(undefined)
  }, [open, tool, form])

  const agentOptions = tool
    ? Array.from(new Set([...tool.agents, ...values.allowedAgents])).map((agent) => ({
        label: agent,
        value: agent,
      }))
    : []

  return (
    <ModalForm<ToolFormValues>
      open={open && tool !== null}
      title={tool ? `编辑工具：${tool.toolKey}` : '编辑工具'}
      form={form}
      dialogClassName="sm:max-w-3xl"
      loading={saving}
      submitText="保存"
      description={dedent`
        改完不需要重启服务，下一次工具调用就生效。
        只提交改动过的字段：留空 / 没碰过的配置不会进请求体；秘钥只进不出，这里永远只看到提示串。
      `}
      onCancel={onClose}
    >
      {tool ? (
        <div className="flex flex-col gap-5">
          {submitError ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>还不能保存</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}

          {!tool.editable ? (
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>这个工具只能查看</AlertTitle>
              <AlertDescription>
                它是运行时（Mastra）自带的技能工具，不进本工程的注册机，
                不受开关与限额控制，保存也会被服务端拒绝。
              </AlertDescription>
            </Alert>
          ) : null}

          <FormSection
            title="工具信息（只读）"
            description="来自代码声明与运行期快照，后台改不了"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ReadonlyItem label="工具 key">
                <span className="font-mono text-xs">{tool.toolKey}</span>
              </ReadonlyItem>
              <ReadonlyItem label="类别">
                <DictTag dict={ToolCategory} value={tool.category} />
              </ReadonlyItem>
              <ReadonlyItem
                label="哪些 agent 声明使用了它（授权在 agent 声明里，库里没有这份数据）"
                span={2}
              >
                {tool.agents.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {tool.agents.map((agent) => (
                      <Tag key={agent} color="processing">
                        {agent}
                      </Tag>
                    ))}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    没有 agent 声明使用它（作用域与授权是两层关卡）
                  </span>
                )}
              </ReadonlyItem>
              {tool.secretFields.length > 0 ? (
                <ReadonlyItem label="秘钥配置情况（只显示提示串，永不回明文）" span={2}>
                  <span className="flex flex-wrap items-center gap-2">
                    {tool.secretFields.map((field) => (
                      <span key={field.name} className="flex items-center gap-1 text-xs">
                        <KeyRoundIcon className="size-3.5 text-muted-foreground" />
                        {field.label}：
                        <span className="font-mono">{field.hint ?? '未配置'}</span>
                        {field.required ? <Tag color="warning">必填</Tag> : null}
                      </span>
                    ))}
                  </span>
                </ReadonlyItem>
              ) : null}
              <ReadonlyItem label="入参定义 paramSchema（只读）" span={2}>
                <ParamSchemaBlock schema={tool.paramSchema} />
              </ReadonlyItem>
            </div>
          </FormSection>

          <FormSection
            title="自定义事件（只读）"
            description="事件在代码里声明、启动期镜像入库，页面只读；这里看的是「可能发什么」，实发内容在对话流的工具卡里看"
          >
            <ToolEventsPanel events={tool.events} />
          </FormSection>

          <FormSection
            title="治理"
            description="开关与作用域都在这里改，改完下一次工具调用生效"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">启用</span>
                <Switch
                  checked={values.enabled}
                  aria-label="工具启用状态"
                  onCheckedChange={(next) => form.setFieldValue('enabled', next === true)}
                />
                <span className="text-xs text-muted-foreground">
                  关掉后调用会被拒；但工具面是装配期快照 —— 提示词里仍然列着它
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">作用域</span>
                <SegmentedControl
                  value={values.scope}
                  options={[ToolScope.All, ToolScope.Agent].map((scope) => ({
                    label: ToolScope.getLabel(scope),
                    value: scope,
                  }))}
                  onValueChange={(next) =>
                    form.setFieldValue('scope', next as typeof ToolScope.All)
                  }
                />
                <span className="text-xs text-muted-foreground">
                  这一次调用允不允许；作用域是第二层关卡，授权仍在 agent 声明里
                </span>
              </div>
              {values.scope === ToolScope.Agent ? (
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <span className="text-sm font-medium">指定 agent</span>
                  <TagsInput
                    value={values.allowedAgents}
                    options={agentOptions}
                    placeholder="输入 agent key 后回车；上方列出的是已声明使用它的 agent"
                    onChange={(next) => form.setFieldValue('allowedAgents', next)}
                  />
                  <span className="text-xs text-muted-foreground">
                    只有这里的 agent 能调它（子 agent 沿用父 agent 的判定）
                  </span>
                </div>
              ) : null}
            </div>
          </FormSection>

          <FormSection
            title="限额"
            description="留空 = 不限制；上限还会被部署侧的硬上限再夹一次"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumberField
                label="每轮最多调用次数"
                hint="一轮对话里这个工具最多被调几次"
                value={values.maxPerTurn}
                onChange={(next) => form.setFieldValue('maxPerTurn', next)}
              />
              <NumberField
                label="限流窗口（秒）"
                hint="与下一项一起填；两项都留空 = 不限流"
                value={values.rateWindowSeconds}
                onChange={(next) => form.setFieldValue('rateWindowSeconds', next)}
              />
              <NumberField
                label="窗口内最多调用次数"
                hint="窗口内超过这个次数调用会被拒"
                value={values.rateMax}
                onChange={(next) => form.setFieldValue('rateMax', next)}
              />
              <NumberField
                label="单页字节数"
                hint="单次给模型的出参上限；留空用工具声明里的值"
                value={values.pageBytes}
                onChange={(next) => form.setFieldValue('pageBytes', next)}
              />
              <NumberField
                label="每轮最多取页次数"
                hint="大结果分页回取的次数上限（防反复取页烧 token）"
                value={values.maxPagesPerTurn}
                onChange={(next) => form.setFieldValue('maxPagesPerTurn', next)}
              />
            </div>
          </FormSection>

          <FormSection
            title="工具专属配置"
            description="一期按工具手写面板；每个字段下方标出代码默认值，可一键用回默认"
          >
            <ToolConfigPanel
              toolKey={tool.toolKey}
              config={values.config}
              defaults={tool.defaultConfig}
              onChange={(key, value) =>
                form.setFieldValue('config', { ...values.config, [key]: value })
              }
            />
          </FormSection>

          {tool.secretFields.length > 0 ? (
            <FormSection
              title="秘钥"
              description={dedent`
                留空 = 不修改；填新值 = 覆盖；勾选「清空」= 提交空串把已存秘钥清掉。
                明文只进不出：接口不会回传已配置的明文，这里只显示提示串。
              `}
            >
              <div className="flex flex-col gap-4">
                {tool.secretFields.map((field) => {
                  const cleared = values.clearSecrets[field.name] === true
                  return (
                    <div key={field.name} className="flex flex-col gap-1.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {field.label}
                        {field.required ? <Tag color="warning">必填</Tag> : null}
                      </span>
                      <Input
                        type="password"
                        value={values.secrets[field.name] ?? ''}
                        disabled={cleared}
                        placeholder={field.hint ?? '未配置'}
                        onChange={(event) =>
                          form.setFieldValue('secrets', {
                            ...values.secrets,
                            [field.name]: event.target.value,
                          })
                        }
                      />
                      <Label className="gap-2 text-xs font-normal text-muted-foreground">
                        <Checkbox
                          checked={cleared}
                          disabled={!field.hint}
                          onCheckedChange={(next) =>
                            form.setFieldValue('clearSecrets', {
                              ...values.clearSecrets,
                              [field.name]: next === true,
                            })
                          }
                        />
                        清空已配置的秘钥（提交空串；输入框禁用期间填的内容不会提交）
                      </Label>
                    </div>
                  )
                })}
              </div>
            </FormSection>
          ) : null}

          <FormSection
            title="恢复默认"
            description={dedent`
              会清掉这个工具的人工覆盖值（开关 / 作用域 / 指定 agent / 限额 / 工具专属配置 / 文案），
              回到代码声明的默认，并清空已配置的秘钥。
            `}
          >
            <div>
              <ConfirmAction
                title={`确认把「${tool.toolKey}」恢复默认？`}
                description={dedent`
                  覆盖值会全部清掉，来源回到「代码声明」；已配置的秘钥一并清空，
                  之后要用得重新填。
                `}
                danger
                okText="恢复默认"
                disabled={!tool.editable}
                onConfirm={async () => {
                  await onReset(tool)
                  onClose()
                }}
              >
                <RotateCcwIcon />
                恢复默认
              </ConfirmAction>
            </div>
          </FormSection>
        </div>
      ) : null}
    </ModalForm>
  )
}
