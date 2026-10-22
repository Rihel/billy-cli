'use client'

import { AI_MODALITIES, AiModality, AiModelMode } from '@repo/shared'
import { useServerClient } from '@/lib/server-client'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  ConfirmAction,
  DataTable,
  DictSelect,
  DictTag,
  DisplayValue,
  EllipsisText,
  EmptyValue,
  IconText,
  Input,
  ModalForm,
  RefreshButton,
  Switch,
  TableActions,
  Tag,
  toastError,
  toastSuccess,
  useDisclosure,
} from '@repo/ui'
import type { DataTableColumnDef, FormFieldContext, FormItem } from '@repo/ui'
import { AiModelSource, AiProviderKind } from '@repo/shared'
import type {
  AiModelCreateDto,
  AiModelModel,
  AiModelUpdateDto,
  AiProviderCreateDto,
  AiProviderModel,
  AiProviderSyncResultModel,
  AiProviderTestDto,
  AiProviderTestResultModel,
  AiProviderUpdateDto,
} from '@repo/shared'
import {
  BoxesIcon,
  CloudDownloadIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  SearchIcon,
} from 'lucide-react'

/**
 * 模型管理（`/main/ai/models`）—— AI 能力的入口：**agent 运行时只能使用这里启用过的模型**（设计 §4.9）。
 *
 * 两步走的工作流（这也是页面的上下两半）：
 * 1. **配供应商**（上半页）：哪家（`kind`）/ 什么地址（`baseUrl`）/ 什么密钥（`apiKey`，只进不出）；
 *    存之前可以先「连通性测试」，配错了当场就知道；
 * 2. **同步 + 启用模型**（下半页）：从供应商的「列模型」接口把明细拉回来（幂等 upsert），
 *    再逐条启用要用的模型。自建网关 `/models` 拉不全时用手工新增补齐（同步不覆盖手工模型）。
 *
 * 三条与后端约定绑定的口径：
 * - **密钥只有两个出口**：`apiKeyHint`（`sk-…abcd`）与 `hasApiKey`；明文永远不回传；
 * - **写密钥只有一条入口**：`apiKey` —— `update` 时省略 = 不改，空串 = 清空（本页留空 = 省略，
 *   勾选「清空已存密钥」= 空串）；
 * - **同步不动人的决定**：模型启停不被同步覆盖；本次未返回的模型只在列表里标注，绝不自动禁用。
 */

/** 供应商表单值 */
type ProviderForm = {
  name: string
  kind: string
  slug: string
  baseUrl: string
  apiKey: string
  /** 编辑时的显式动作：勾选 = 提交空串清空已存密钥（新建时不出现） */
  clearApiKey: boolean
  enabled: boolean
}

/** 模型表单值（手工新增 / 编辑共用；`modelKey` 不可改） */
type ModelForm = {
  modelKey: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  enabled: boolean
  /** 模型类型（见 `AiModelMode`） */
  mode: string
  /**
   * 输入模态（多选）。
   *
   * `undefined` = **未声明**（供应商没给、人也没填）→ 附件不拦，只提醒；
   * `[]` = 明确声明什么输入都不支持 → 图片 / 文件会被拦下。
   */
  inputModalities?: string[]
  /** 输出模态（多选；我们只做对话，实际基本就是 `text`） */
  outputModalities?: string[]
}

/** 供应商表单初值（新建用） */
const PROVIDER_FORM_DEFAULTS: ProviderForm = {
  name: '',
  kind: AiProviderKind.OpenaiCompatible,
  slug: '',
  baseUrl: '',
  apiKey: '',
  clearApiKey: false,
  enabled: true,
}

/** 模型表单初值（新建用；输出模态默认声明「文本」） */
const MODEL_FORM_DEFAULTS: ModelForm = {
  modelKey: '',
  displayName: '',
  contextWindow: undefined,
  maxOutputTokens: undefined,
  enabled: true,
  mode: 'chat',
  inputModalities: undefined,
  outputModalities: ['text'],
}

/**
 * 编辑前的**清空值**（两个表单共用思路）。
 *
 * 为什么不能只靠 `values` 回填：`ModalForm` 会跳过值为 `undefined` 的键
 * （`packages/ui/src/components/modal-form.tsx`），于是"未声明"的字段会**保留上一条记录的值** ——
 * 编辑一个"输出模态未声明"的模型时，会把上一条的 `['text']` 静默写回去。
 * 所以编辑前先 `reset` 到这份全空值，再由 `values` 覆盖有值的键。
 */
const PROVIDER_FORM_BLANK: ProviderForm = {
  name: '',
  kind: '',
  slug: '',
  baseUrl: '',
  apiKey: '',
  clearApiKey: false,
  enabled: false,
}

const MODEL_FORM_BLANK: ModelForm = {
  modelKey: '',
  displayName: '',
  contextWindow: undefined,
  maxOutputTokens: undefined,
  enabled: false,
  mode: 'chat',
  inputModalities: undefined,
  outputModalities: undefined,
}

/** 模态多选（用复选框而不是下拉多选：取值少、一眼看清当前声明了什么） */
function ModalityPicker({
  value,
  onChange,
  disabled,
}: {
  value: string[] | undefined
  onChange: (next: string[] | undefined) => void
  disabled?: boolean
}) {
  const selected = value ?? []
  const isUndeclared = value === undefined
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-3">
        {AI_MODALITIES.map((modality) => (
          <label key={modality} className="flex items-center gap-1.5 text-sm">
            <Checkbox
              checked={selected.includes(modality)}
              disabled={disabled}
              onCheckedChange={(checked) => {
                const next = checked
                  ? [...selected, modality]
                  : selected.filter((item) => item !== modality)
                // 一个都不留 = 明确声明"什么输入都不支持"（与"未声明"是两件事）
                onChange(next)
              }}
            />
            <DictTag dict={AiModality} value={modality} />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {isUndeclared ? '当前：未声明（附件不会被拦下，只在会话页提醒）' : `当前：${selected.length ? selected.join(' / ') : '明确声明不支持任何输入'}`}
        </span>
        {!isUndeclared ? (
          <Button onClick={() => onChange(undefined)} size="sm" type="button" variant="ghost">
            撤回未声明
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** slug 规则与后端一致：小写字母 / 数字 / 连字符，且以字母或数字开头 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** 地址只做「像不像 URL」的前置校验，真正的可用性交给「连通性测试」 */
const URL_PATTERN = /^https?:\/\/\S+$/

/**
 * 取时间戳（定义里这两个时间字段是 `string | Date | undefined`，直接 `new Date(Date)` 过不了类型）。
 * 取不到（未同步 / 从未出现）返回 undefined —— 调用方据此不标注。
 */
const toTimestamp = (value?: string | Date | null): number | undefined => {
  if (value === null || value === undefined) return undefined
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

export default function AiModelsPage() {
  const client = useServerClient()

  // 供应商列表分页
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  // 当前选中的供应商：下半页（模型明细）的作用域
  const [selectedProvider, setSelectedProvider] = useState<AiProviderModel>()
  // 模型列表分页 + 关键词
  const [modelPage, setModelPage] = useState(1)
  const [modelPageSize, setModelPageSize] = useState(10)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [searchText, setSearchText] = useState('')
  // 连通性测试结果（对话内展示，不落库）
  const [testResult, setTestResult] = useState<AiProviderTestResultModel>()
  // 最近一次同步结果（只在对应供应商的模型表上方展示）
  const [syncResult, setSyncResult] = useState<AiProviderSyncResultModel>()
  /**
   * 编辑**回填值**（走 `ModalForm` 的 `values` 通道）。
   *
   * 为什么不能只靠 `form.reset(...)`：这套 UI 里 widget 的显示值取自 `form.store.values`，
   * 而自定义 `render`（本页的「模型类型」下拉与「输入 / 输出模态」）读的是 `field.state.value` ——
   * 它滞后于 reset，表现就是"点了编辑，下拉框和多选框还是空的"。
   * `ModalForm` 为此专门留了 `values`（打开时逐字段 `setFieldValue`），编辑一律走这里。
   */
  const [providerValues, setProviderValues] = useState<Partial<ProviderForm>>()
  const [modelValues, setModelValues] = useState<Partial<ModelForm>>()

  const createProviderDialog = useDisclosure()
  const editProviderDialog = useDisclosure<AiProviderModel>()
  const createModelDialog = useDisclosure()
  const editModelDialog = useDisclosure<AiModelModel>()

  const providersQuery = useQuery({
    queryKey: ['aiModel', 'provider', 'list', { page, pageSize }],
    queryFn: () => client.aiModel.provider.list({ page, size: pageSize }),
  })

  const modelsQuery = useQuery({
    enabled: Boolean(selectedProvider),
    queryKey: [
      'aiModel',
      'model',
      'list',
      {
        providerId: selectedProvider?.id,
        keyword,
        page: modelPage,
        pageSize: modelPageSize,
      },
    ],
    queryFn: () =>
      client.aiModel.model.list({
        providerId: selectedProvider!.id,
        keyword,
        page: modelPage,
        size: modelPageSize,
      }),
  })

  const refetchProviders = providersQuery.refetch
  const refetchModels = modelsQuery.refetch

  // 列表 refetch（同步 / 编辑 / 启停）后刷新选中项快照：
  // 「本次未返回」的判断要用最新的 lastSyncedAt，不能拿旧对象比
  useEffect(() => {
    if (!selectedProvider) return
    const latest = providersQuery.data?.items.find(
      (item) => item.id === selectedProvider.id,
    )
    if (latest && latest !== selectedProvider) setSelectedProvider(latest)
  }, [providersQuery.data, selectedProvider])

  const createProviderMutation = useMutation({
    mutationFn: (input: AiProviderCreateDto) =>
      client.aiModel.provider.create(input),
  })

  const updateProviderMutation = useMutation({
    mutationFn: (input: AiProviderUpdateDto) =>
      client.aiModel.provider.update(input),
  })

  const removeProviderMutation = useMutation({
    mutationFn: (input: { providerId: string }) =>
      client.aiModel.provider.remove(input),
  })

  const syncMutation = useMutation({
    mutationFn: (input: { providerId: string }) =>
      client.aiModel.provider.sync(input),
  })

  const testMutation = useMutation({
    mutationFn: (input: AiProviderTestDto) => client.aiModel.provider.test(input),
    onSuccess(result) {
      setTestResult(result)
      if (result.ok) {
        toastSuccess(
          `连通成功：拉到 ${result.modelCount} 个模型`,
          `用时 ${result.durationMs}ms · ${result.endpoint}`,
        )
      } else {
        toastError('连通失败', result.error ?? result.endpoint)
      }
    },
  })

  const createModelMutation = useMutation({
    mutationFn: (input: AiModelCreateDto) => client.aiModel.model.create(input),
  })

  const updateModelMutation = useMutation({
    mutationFn: (input: AiModelUpdateDto) => client.aiModel.model.update(input),
  })

  const removeModelMutation = useMutation({
    mutationFn: (input: { modelId: string }) => client.aiModel.model.remove(input),
  })

  /** 选中供应商：切换作用域，并清掉上一家的分页 / 搜索 / 同步结果 */
  const handleSelectProvider = (provider: AiProviderModel) => {
    setSelectedProvider(provider)
    setModelPage(1)
    setKeyword(undefined)
    setSearchText('')
    setSyncResult(undefined)
  }

  const openCreateProvider = () => {
    providerForm.reset(PROVIDER_FORM_DEFAULTS)
    setProviderValues(undefined)
    setTestResult(undefined)
    createProviderDialog.open()
  }

  const openEditProvider = (provider: AiProviderModel) => {
    // 先清成空壳（避免上一次编辑的残留串过来），再由 ModalForm 的 `values` 回填
    providerForm.reset(PROVIDER_FORM_BLANK)
    setProviderValues({
      name: provider.name,
      kind: provider.kind,
      // slug 回显当前值：它是模型对外标识的前半段，改了要让人看见改的是什么
      slug: provider.slug,
      baseUrl: provider.baseUrl ?? '',
      // 明文永不回传：输入框只能从空开始，留空 = 不改
      apiKey: '',
      clearApiKey: false,
      enabled: provider.enabled,
    })
    setTestResult(undefined)
    editProviderDialog.open(provider)
  }

  const openCreateModel = () => {
    modelForm.reset(MODEL_FORM_DEFAULTS)
    setModelValues(undefined)
    createModelDialog.open()
  }

  const openEditModel = (model: AiModelModel) => {
    modelForm.reset(MODEL_FORM_BLANK)
    setModelValues({
      modelKey: model.modelKey,
      displayName: model.displayName,
      contextWindow: model.contextWindow ?? undefined,
      maxOutputTokens: model.maxOutputTokens ?? undefined,
      enabled: model.enabled,
      mode: model.mode,
      // `null` = 未声明（区别于"空数组 = 明确声明什么都不支持"）
      inputModalities: model.inputModalities ?? undefined,
      outputModalities: model.outputModalities ?? undefined,
    })
    editModelDialog.open(model)
  }

  /**
   * 连通性测试：**支持未保存先测** —— 表单里已填的 `kind` / `baseUrl` / `apiKey` 直接传。
   * 密钥留空且正在编辑已有供应商时，只传 `providerId`，由后端取库里已存的密钥（明文不出库）。
   */
  const handleTest = (values: ProviderForm) => {
    // 勾了「清空已存密钥」时输入框已禁用，其中残留的旧文本不算数（保存时也不会提交）
    const apiKey = values.clearApiKey ? '' : values.apiKey.trim()
    const baseUrl = values.baseUrl.trim()
    const providerId =
      editProviderDialog.isOpen && editProviderDialog.data
        ? editProviderDialog.data.id
        : undefined
    setTestResult(undefined)
    testMutation.mutate({
      kind: values.kind || AiProviderKind.OpenaiCompatible,
      baseUrl: baseUrl || undefined,
      apiKey: apiKey || undefined,
      // 填了新密钥就以新密钥为准；留空才退回「用库里已存的」
      providerId: apiKey ? undefined : providerId,
    })
  }

  const providerForm = useForm({
    // openai-compatible 是本工程主力（DeepSeek / 百炼兼容模式 / vLLM / 自建网关都是这个形态）
    defaultValues: PROVIDER_FORM_DEFAULTS,
    onSubmit: async ({ value }) => {
      const name = value.name.trim()
      const slug = value.slug.trim()
      const baseUrl = value.baseUrl.trim()
      const apiKey = value.apiKey.trim()

      if (editProviderDialog.isOpen && editProviderDialog.data) {
        await updateProviderMutation.mutateAsync({
          providerId: editProviderDialog.data.id,
          name,
          kind: value.kind,
          // 编辑时 slug 必填（已回显原值），提交的就是输入框里的值
          slug,
          // 传 null = 清空地址（回到该 kind 的官方默认地址）
          baseUrl: baseUrl || null,
          // 密钥三态：「省略 = 不改，空串 = 清空」——
          // 勾选「清空已存密钥」→ 空串；填了新密钥 → 新密钥；两者都没有 → 省略（不改）
          ...(value.clearApiKey ? { apiKey: '' } : apiKey ? { apiKey } : {}),
          enabled: value.enabled,
        })
        toastSuccess('供应商已更新')
        editProviderDialog.close()
      } else {
        await createProviderMutation.mutateAsync({
          name,
          kind: value.kind,
          slug: slug || undefined,
          baseUrl: baseUrl || undefined,
          apiKey: apiKey || undefined,
          enabled: value.enabled,
        })
        toastSuccess('供应商已创建', '下一步：测试连通性 → 同步模型')
        createProviderDialog.close()
      }
      setTestResult(undefined)
      void refetchProviders()
    },
  })

  const modelForm = useForm({
    defaultValues: MODEL_FORM_DEFAULTS,
    onSubmit: async ({ value }) => {
      const displayName = value.displayName.trim()

      if (editModelDialog.isOpen && editModelDialog.data) {
        await updateModelMutation.mutateAsync({
          modelId: editModelDialog.data.id,
          displayName: displayName || undefined,
          // 输入框清空 = 显式清掉窗口（传 null）；不填不动
          contextWindow: value.contextWindow ?? null,
          maxOutputTokens: value.maxOutputTokens ?? null,
          enabled: value.enabled,
          mode: value.mode as never,
          // 三态：`undefined` = 撤成"未声明"（传 null），数组就是明确声明
          inputModalities: (value.inputModalities ?? null) as never,
          outputModalities: (value.outputModalities ?? null) as never,
        })
        toastSuccess('模型已更新')
        editModelDialog.close()
      } else {
        if (!selectedProvider) return
        await createModelMutation.mutateAsync({
          providerId: selectedProvider.id,
          modelKey: value.modelKey.trim(),
          displayName: displayName || undefined,
          contextWindow: value.contextWindow ?? undefined,
          maxOutputTokens: value.maxOutputTokens ?? undefined,
          enabled: value.enabled,
        })
        toastSuccess('模型已新增', '手工模型不会被同步覆盖')
        createModelDialog.close()
      }
      void refetchModels()
    },
  })

  /** 连通性测试结果（成功 / 失败都留在表单里，便于对着原文改） */
  const testResultBlock = testResult ? (
    testResult.ok ? (
      <Alert>
        <PlugZapIcon />
        <AlertTitle>连通成功</AlertTitle>
        <AlertDescription>
          拉到 {testResult.modelCount} 个模型，用时 {testResult.durationMs}ms
          <br />
          请求地址：<span className="font-mono text-xs">{testResult.endpoint}</span>
        </AlertDescription>
      </Alert>
    ) : (
      <Alert variant="destructive">
        <PlugZapIcon />
        <AlertTitle>连通失败</AlertTitle>
        <AlertDescription>
          {testResult.error ?? '供应商没有返回可读原因'}
          <br />
          请求地址：<span className="font-mono text-xs">{testResult.endpoint}</span>
        </AlertDescription>
      </Alert>
    )
  ) : null

  const providerFormItems: FormItem<ProviderForm>[] = [
    {
      title: '接入信息',
      fields: [
        {
          name: 'name',
          label: '展示名',
          span: 2,
          required: '请输入展示名',
          hint: '便于识别的名字，全局唯一，如「DeepSeek 官方」「自建网关」',
        },
        {
          name: 'kind',
          label: '供应商类型',
          span: 2,
          required: true,
          hint: '决定用哪家的「列模型」接口拉明细；自建网关 / 代理 / 中转选「OpenAI 兼容」',
          render: ({ values, field }: FormFieldContext<ProviderForm>) => (
            <DictSelect
              dict={AiProviderKind}
              value={typeof values.kind === 'string' ? values.kind : null}
              triggerClassName="w-full"
              onValueChange={(next) => field.handleChange(next ?? '')}
            />
          ),
        },
        {
          name: 'slug',
          label: '标识（slug）',
          // 编辑时已回显原值，不允许清空：它是 <slug>/<modelKey> 的前半段，清掉会破坏已有标识
          required: editProviderDialog.isOpen ? '请输入标识（slug）' : undefined,
          hint: editProviderDialog.isOpen
            ? '模型标识的前半段，如 deepseek → deepseek/deepseek-chat'
            : '模型标识的前半段，如 deepseek → deepseek/deepseek-chat；留空由展示名生成',
          validate: (value) => {
            if (typeof value !== 'string' || value.length === 0) return undefined
            if (!SLUG_PATTERN.test(value)) {
              return '只能是小写字母 / 数字 / 连字符，且以字母或数字开头'
            }
            return value.length > 32 ? '最长 32 个字符' : undefined
          },
        },
        {
          name: 'baseUrl',
          label: '接口地址',
          hint: '留空用官方地址；自建网关必须填',
          validate: (value) =>
            typeof value === 'string' && value.length > 0 && !URL_PATTERN.test(value)
              ? '请输入以 http:// 或 https:// 开头的完整地址'
              : undefined,
        },
        {
          name: 'apiKey',
          label: '密钥',
          span: 2,
          widget: 'password',
          // 勾了「清空已存密钥」就没什么可填的了，直接禁用，避免「填了却不提交」的误解
          disabled: (values) => values.clearApiKey === true,
          hint: editProviderDialog.isOpen
            ? '留空表示不修改。明文不会回传，列表只显示提示（如 sk-…abcd）'
            : '加密存储，明文永不回传；列表只显示提示（如 sk-…abcd）',
        },
        {
          // 只在编辑时出现：新增没有「已存密钥」可清
          name: 'clearApiKey',
          span: 2,
          hidden: () => !editProviderDialog.isOpen,
          render: ({ values, field }: FormFieldContext<ProviderForm>) => {
            const checked = values.clearApiKey === true
            return (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) => field.handleChange(next === true)}
                />
                <span className="flex flex-col gap-0.5">
                  <span>清空已存密钥</span>
                  <span className="text-xs text-muted-foreground">
                    {checked
                      ? '保存后将删除已存密钥（上方输入框已禁用，填了也不会提交）；之后「同步模型」会失败，直到重新配好密钥'
                      : '勾选后保存将删除已存密钥；不勾选且上方留空 = 不修改'}
                  </span>
                </span>
              </label>
            )
          },
        },
        {
          name: 'enabled',
          label: '启用',
          widget: 'switch',
          hint: '关闭后该供应商不参与运行时选型；它的模型明细仍可查看',
        },
        {
          name: 'connectTest',
          label: '连通性测试',
          span: 2,
          hint: '用当前填写的类型 / 地址 / 密钥请求供应商的「列模型」接口，只测不落库',
          render: ({ values }: FormFieldContext<ProviderForm>) => (
            <div className="flex flex-col gap-3">
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={testMutation.isPending}
                  onClick={() => handleTest(values)}
                >
                  <PlugZapIcon />
                  {testMutation.isPending ? '测试中…' : '测试连通性'}
                </Button>
              </div>
              {testResultBlock}
            </div>
          ),
        },
      ],
    },
  ]

  const modelFormItems = (isEdit: boolean): FormItem<ModelForm>[] => [
    {
      title: '模型信息',
      fields: [
        {
          name: 'modelKey',
          label: '模型标识',
          span: 2,
          required: isEdit ? undefined : '请输入模型标识',
          disabled: isEdit,
          props: isEdit ? { readOnly: true } : undefined,
          hint: isEdit
            ? '供应商侧的模型 id，创建后不可修改'
            : '供应商侧的模型 id，如 deepseek-chat；同一供应商下唯一',
          validate: (value) =>
            typeof value === 'string' && value.length > 0 && /\s/.test(value)
              ? '不能包含空格'
              : undefined,
        },
        {
          name: 'displayName',
          label: '展示名',
          hint: '给人看的名字；留空则同步时按供应商返回的名字回填',
        },
        {
          name: 'contextWindow',
          label: '上下文窗口（token）',
          widget: 'number',
          hint: '上下文裁剪与压缩的触发线就按它算。同步时供应商给了就用供应商的，没给就保留这里填的值；留空退回 32K 兜底并打一条 warn',
        },
        {
          name: 'maxOutputTokens',
          label: '最大输出（token）',
          widget: 'number',
          hint: '单次输出的上限，留空表示未知',
        },
        {
          name: 'enabled',
          label: '启用',
          widget: 'switch',
          hint: '只有启用的模型才能被 agent 运行时选用（关闭不被同步覆盖）',
        },
        {
          name: 'mode',
          label: '模型类型',
          hint: '只有对话 / 文本补全类会出现在会话页的模型选择器里（未声明的照列，真选错了报错也看得懂）',
          render: ({ field }: FormFieldContext<ModelForm>) => (
            <DictSelect
              dict={AiModelMode}
              onValueChange={(next) => field.handleChange(next ?? 'chat')}
              triggerClassName="w-full"
              value={(field.state.value as string) || 'chat'}
            />
          ),
        },
        {
          name: 'inputModalities',
          label: '输入模态',
          span: 2,
          render: ({ field }) => (
            <div className="flex flex-col gap-1">
              <span className="text-sm">输入模态</span>
              <ModalityPicker
                onChange={(next) => field.handleChange(next as never)}
                value={field.state.value as string[] | undefined}
              />
              <span className="text-xs text-muted-foreground">
                供应商的「列模型」接口多数不给这项；不声明时附件不会被拦下，只在会话页提醒
              </span>
            </div>
          ),
        },
        {
          name: 'outputModalities',
          label: '输出模态',
          span: 2,
          render: ({ field }) => (
            <div className="flex flex-col gap-1">
              <span className="text-sm">输出模态</span>
              <ModalityPicker
                onChange={(next) => field.handleChange(next as never)}
                value={field.state.value as string[] | undefined}
              />
              <span className="text-xs text-muted-foreground">我们只做对话，通常只勾「文本」</span>
            </div>
          ),
        },
      ],
    },
  ]

  /** 「本次未返回」：供应商最近一次成功同步之后，这个模型再没出现过（限流也会这样，故只提示不禁用） */
  const selectedSyncedAt = toTimestamp(selectedProvider?.lastSyncedAt)
  const isMissingInLastSync = (model: AiModelModel): boolean => {
    const seenAt = toTimestamp(model.lastSeenAt)
    if (selectedSyncedAt === undefined || seenAt === undefined) return false
    return seenAt < selectedSyncedAt
  }

  const providerColumns: DataTableColumnDef<AiProviderModel>[] = [
    {
      header: '展示名',
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{row.original.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.id}
          </span>
        </div>
      ),
    },
    {
      header: 'slug',
      accessorKey: 'slug',
      meta: { width: 140 },
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.slug}</span>
      ),
    },
    {
      header: '类型',
      accessorKey: 'kind',
      meta: { width: 130 },
      cell: ({ row }) => (
        <DictTag dict={AiProviderKind} value={row.original.kind} />
      ),
    },
    {
      header: '接口地址',
      accessorKey: 'baseUrl',
      meta: { width: 230 },
      cell: ({ row }) => (
        <EmptyValue
          value={row.original.baseUrl}
          emptyText={
            <span className="text-muted-foreground">官方默认地址</span>
          }
        >
          <EllipsisText className="max-w-[210px] font-mono text-xs">
            {row.original.baseUrl}
          </EllipsisText>
        </EmptyValue>
      ),
    },
    {
      header: '密钥',
      accessorKey: 'hasApiKey',
      meta: { width: 130 },
      cell: ({ row }) =>
        row.original.hasApiKey ? (
          <span className="font-mono text-xs">
            {row.original.apiKeyHint ?? '已配置'}
          </span>
        ) : (
          <Tag color="warning">未配置</Tag>
        ),
    },
    {
      header: '启用',
      accessorKey: 'enabled',
      meta: { width: 80 },
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          disabled={updateProviderMutation.isPending}
          aria-label="供应商启用状态"
          onCheckedChange={(checked) => {
            updateProviderMutation.mutate(
              { providerId: row.original.id, enabled: checked },
              {
                onSuccess: () => {
                  toastSuccess(checked ? '供应商已启用' : '供应商已停用')
                  void refetchProviders()
                },
              },
            )
          }}
        />
      ),
    },
    {
      header: '最后同步',
      accessorKey: 'lastSyncedAt',
      meta: { width: 170 },
      cell: ({ getValue }) => (
        <DisplayValue
          type="date"
          value={getValue()}
          emptyText={<span className="text-muted-foreground">从未同步</span>}
        />
      ),
    },
    {
      header: '同步失败原因',
      accessorKey: 'lastSyncError',
      meta: { width: 200 },
      cell: ({ row }) => (
        <EmptyValue
          value={row.original.lastSyncError}
          emptyText={<span className="text-muted-foreground">-</span>}
        >
          <EllipsisText className="max-w-[180px] text-destructive">
            {row.original.lastSyncError}
          </EllipsisText>
        </EmptyValue>
      ),
    },
    {
      header: '操作',
      id: 'actions',
      meta: { width: 300 },
      cell: ({ row }) => (
        <TableActions>
          <IconText
            icon={<BoxesIcon />}
            size="small"
            type={selectedProvider?.id === row.original.id ? 'primary' : 'default'}
            onClick={() => handleSelectProvider(row.original)}
          >
            模型
          </IconText>
          <IconText
            icon={<PencilIcon />}
            size="small"
            type="primary"
            onClick={() => openEditProvider(row.original)}
          >
            编辑
          </IconText>
          <IconText
            icon={<CloudDownloadIcon />}
            size="small"
            type="primary"
            loading={syncMutation.isPending}
            disabled={syncMutation.isPending}
            onClick={() =>
              syncMutation.mutate(
                { providerId: row.original.id },
                {
                  onSuccess: (result) => {
                    // 同步结果只在与选中供应商匹配时展示，避免张冠李戴
                    if (selectedProvider?.id === result.providerId) {
                      setSyncResult(result)
                    }
                    toastSuccess(
                      `「${row.original.name}」模型同步完成`,
                      `新增 ${result.created} / 更新 ${result.updated} / 未变 ${result.unchanged} / 本次未返回 ${result.missing}`,
                    )
                    void refetchProviders()
                    if (selectedProvider) void refetchModels()
                  },
                },
              )
            }
          >
            同步模型
          </IconText>
          <ConfirmAction
            title={`确认删除供应商「${row.original.name}」？`}
            description="它下面的模型会一并软删；配置类数据保留历史，便于排查当时用的是哪个模型。"
            danger
            onConfirm={() =>
              removeProviderMutation.mutate(
                { providerId: row.original.id },
                {
                  onSuccess: () => {
                    if (selectedProvider?.id === row.original.id) {
                      setSelectedProvider(undefined)
                      setSyncResult(undefined)
                    }
                    toastSuccess('供应商已删除')
                    void refetchProviders()
                  },
                },
              )
            }
          >
            删除
          </ConfirmAction>
        </TableActions>
      ),
    },
  ]

  const modelColumns: DataTableColumnDef<AiModelModel>[] = [
    {
      header: '模型标识',
      accessorKey: 'modelKey',
      meta: { width: 200 },
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.modelKey}</span>
      ),
    },
    {
      header: '展示名',
      accessorKey: 'displayName',
      cell: ({ row }) => (
        <EmptyValue
          value={row.original.displayName}
          emptyText={<span className="text-muted-foreground">-</span>}
        >
          {row.original.displayName}
        </EmptyValue>
      ),
    },
    {
      header: '上下文窗口',
      accessorKey: 'contextWindow',
      meta: { width: 120 },
      cell: ({ row }) => (
        <EmptyValue
          value={row.original.contextWindow}
          emptyText={<span className="text-muted-foreground">-</span>}
        >
          {row.original.contextWindow?.toLocaleString()}
        </EmptyValue>
      ),
    },
    {
      header: '最大输出',
      accessorKey: 'maxOutputTokens',
      meta: { width: 110 },
      cell: ({ row }) => (
        <EmptyValue
          value={row.original.maxOutputTokens}
          emptyText={<span className="text-muted-foreground">-</span>}
        >
          {row.original.maxOutputTokens?.toLocaleString()}
        </EmptyValue>
      ),
    },
    {
      header: '类型',
      accessorKey: 'mode',
      meta: { width: 110 },
      cell: ({ row }) => <DictTag dict={AiModelMode} value={row.original.mode} />,
    },
    {
      header: '输入模态',
      accessorKey: 'inputModalities',
      meta: { width: 150 },
      cell: ({ row }) => {
        /**
         * **未声明（null）与"什么都不支持"（空数组）要分清**：
         * 前者是"我们不知道"（附件不会被拦，只在会话页提醒），后者是明确声明不支持。
         * 混成一句话显示，用户会误以为要去后台补配置 —— 或者更糟，以为模型能收图。
         */
        const modalities = row.original.inputModalities
        if (modalities === null) {
          return <span className="text-xs text-muted-foreground">未声明</span>
        }
        if (modalities.length === 0) {
          return <span className="text-xs text-warning">仅文本（明确声明）</span>
        }
        return (
          <span className="flex flex-wrap items-center gap-1">
            {modalities.map((modality) => (
              <DictTag key={modality} dict={AiModality} value={modality} />
            ))}
          </span>
        )
      },
    },
    {
      header: '来源',
      accessorKey: 'source',
      meta: { width: 90 },
      cell: ({ row }) => (
        <DictTag dict={AiModelSource} value={row.original.source} />
      ),
    },
    {
      header: '启用',
      accessorKey: 'enabled',
      meta: { width: 80 },
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          disabled={updateModelMutation.isPending}
          aria-label="模型启用状态"
          onCheckedChange={(checked) => {
            updateModelMutation.mutate(
              { modelId: row.original.id, enabled: checked },
              {
                onSuccess: () => {
                  toastSuccess(checked ? '模型已启用' : '模型已停用')
                  void refetchModels()
                },
              },
            )
          }}
        />
      ),
    },
    {
      header: '最后出现',
      accessorKey: 'lastSeenAt',
      meta: { width: 230 },
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <DisplayValue
            type="date"
            value={row.original.lastSeenAt}
            emptyText={
              <span className="text-muted-foreground">未在供应商列表出现</span>
            }
          />
          {isMissingInLastSync(row.original) ? (
            <Tag color="warning">本次未返回</Tag>
          ) : null}
        </div>
      ),
    },
    {
      header: '操作',
      id: 'actions',
      meta: { width: 150 },
      cell: ({ row }) => (
        <TableActions>
          <IconText
            icon={<PencilIcon />}
            size="small"
            type="primary"
            onClick={() => openEditModel(row.original)}
          >
            编辑
          </IconText>
          <ConfirmAction
            title={`确认删除模型「${row.original.modelKey}」？`}
            description="删除后 agent 不能再选它；下次同步如果供应商还返回它，会重新出现（未启用）。"
            danger
            onConfirm={() =>
              removeModelMutation.mutate(
                { modelId: row.original.id },
                {
                  onSuccess: () => {
                    toastSuccess('模型已删除')
                    void refetchModels()
                  },
                },
              )
            }
          >
            删除
          </ConfirmAction>
        </TableActions>
      ),
    },
  ]

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4 sm:p-8">
      <DataTable<AiProviderModel>
        title="模型供应商"
        description="先配「哪家 / 地址 / 密钥」，再从它的接口同步模型明细；密钥只进不出，明文永不回传"
        toolbar={
          <>
            <RefreshButton
              loading={providersQuery.isFetching}
              onClick={() => void refetchProviders()}
            />
            <Button onClick={openCreateProvider}>
              <PlusIcon />
              新建供应商
            </Button>
          </>
        }
        rowKey="id"
        loading={providersQuery.isFetching}
        columns={providerColumns}
        data={providersQuery.data?.items}
        page={page}
        pageSize={pageSize}
        total={providersQuery.data?.total}
        onPageChange={(nextPage, nextPageSize) => {
          setPage(nextPage)
          setPageSize(nextPageSize)
        }}
        emptyText="还没有供应商：点右上角「新建供应商」，填好类型 / 地址 / 密钥后先测连通性，再保存并同步模型"
      />

      <DataTable<AiModelModel>
        title={selectedProvider ? `模型明细：${selectedProvider.name}` : '模型明细'}
        description="agent 运行时只能使用「供应商启用 + 模型启用」的模型；同步不会覆盖你的启停决定，本次未返回的只标注、不禁用"
        toolbar={
          <>
            <RefreshButton
              loading={modelsQuery.isFetching}
              disabled={!selectedProvider}
              onClick={() => void refetchModels()}
            />
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 transition-colors focus-within:ring-2 focus-within:ring-ring/40">
              <SearchIcon className="ml-0.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索模型标识 / 展示名..."
                value={searchText}
                disabled={!selectedProvider}
                onChange={(event) => {
                  setSearchText(event.target.value)
                  if (event.target.value === '') {
                    setKeyword(undefined)
                    setModelPage(1)
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    setKeyword(searchText.trim() || undefined)
                    setModelPage(1)
                  }
                }}
                className="h-7 w-48 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
              />
            </div>
            <Button disabled={!selectedProvider} onClick={openCreateModel}>
              <PlusIcon />
              手工新增模型
            </Button>
          </>
        }
        rowKey="id"
        loading={modelsQuery.isFetching}
        columns={modelColumns}
        data={selectedProvider ? modelsQuery.data?.items : []}
        page={modelPage}
        pageSize={modelPageSize}
        total={selectedProvider ? modelsQuery.data?.total : 0}
        onPageChange={(nextPage, nextPageSize) => {
          setModelPage(nextPage)
          setModelPageSize(nextPageSize)
        }}
        emptyText={
          selectedProvider
            ? '这个供应商还没有模型：点「同步模型」从供应商接口拉明细；自建网关拉不全时用「手工新增模型」补齐'
            : '请先在上方供应商列表点「模型」选中一个供应商，再同步 / 启用它的模型'
        }
      />

      {/* 同步结果（toast 会消失，这里留一份可回看的明细） */}
      {syncResult && selectedProvider?.id === syncResult.providerId ? (
        <Alert>
          <CloudDownloadIcon />
          <AlertTitle>最近一次同步结果</AlertTitle>
          <AlertDescription>
            供应商本次返回 {syncResult.total} 个模型：新增 {syncResult.created} / 更新{' '}
            {syncResult.updated} / 未变 {syncResult.unchanged} / 本次未返回{' '}
            {syncResult.missing}
            <br />
            同步时间：<DisplayValue type="date" value={syncResult.syncedAt} />
            {syncResult.missing > 0
              ? '（「本次未返回」只提示，可能是下线或限流，不会自动禁用）'
              : ''}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 新建 / 编辑供应商（同一个表单：编辑走 form.reset 预填） */}
      <ModalForm<ProviderForm>
        title={editProviderDialog.isOpen ? '编辑供应商' : '新建供应商'}
        open={createProviderDialog.isOpen || editProviderDialog.isOpen}
        form={providerForm}
        // 编辑才回填；新建保持初值（避免上一次编辑的值出现在新建表单里）
        values={editProviderDialog.isOpen ? providerValues : undefined}
        dialogClassName="sm:max-w-xl"
        items={providerFormItems}
        description="供应商 = 一家模型服务接入（哪家 / 地址 / 密钥）。保存后回到列表点「同步模型」拉明细。"
        onCancel={() => {
          createProviderDialog.close()
          editProviderDialog.close()
          setTestResult(undefined)
        }}
      />

      {/* 手工新增 / 编辑模型（同一个表单；modelKey 创建后不可改） */}
      <ModalForm<ModelForm>
        title={editModelDialog.isOpen ? '编辑模型' : '手工新增模型'}
        open={createModelDialog.isOpen || editModelDialog.isOpen}
        form={modelForm}
        values={editModelDialog.isOpen ? modelValues : undefined}
        dialogClassName="sm:max-w-xl"
        items={modelFormItems(editModelDialog.isOpen)}
        description={
          editModelDialog.isOpen
            ? '可改展示名 / 上下文窗口 / 最大输出 / 启停；模型标识由供应商侧决定，不可改。'
            : '自建网关的 /models 拉不全时用；手工模型不会被同步覆盖（同步只补它没见过的）。'
        }
        onCancel={() => {
          createModelDialog.close()
          editModelDialog.close()
        }}
      />
    </div>
  )
}
