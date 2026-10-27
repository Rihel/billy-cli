import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "#components/ui/command.tsx"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "#components/ui/dialog.tsx"
import { cn } from "#lib/utils.ts"
import type { ComponentProps, ReactNode } from "react"

export type ModelSelectorProps = ComponentProps<typeof Dialog>

export const ModelSelector = (props: ModelSelectorProps) => <Dialog {...props} />

export type ModelSelectorTriggerProps = ComponentProps<typeof DialogTrigger>

export const ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => <DialogTrigger {...props} />

export type ModelSelectorContentProps = ComponentProps<typeof DialogContent> & {
  title?: ReactNode
}

/**
 * 模型选择弹窗。
 *
 * 宽度**必须自己给**：`DialogContent` 的默认宽度是 `sm:max-w-sm`（384px），
 * 而一行模型要放"名字 + 模态徽标 + `provider/model` + 窗口"四样东西 —— 384px 装不下，
 * 剩下的名字被压到只剩一个字母（实测名字列 7.9px，界面看起来就是模型名消失了）。
 * 672px（`max-w-2xl`）刚好让名字占住主要宽度、`provider/model` 与窗口各就各位；
 * 窄屏仍由 `DialogContent` 的 `max-w-[calc(100%-2rem)]` 兜住。
 */
export const ModelSelectorContent = ({ className, children, title = "Model Selector", ...props }: ModelSelectorContentProps) => (
  <DialogContent
    aria-describedby={undefined}
    className={cn("sm:max-w-2xl outline! border-none! p-0 outline-border! outline-solid!", className)}
    {...props}
  >
    <DialogTitle className="sr-only">{title}</DialogTitle>
    <Command className="**:data-[slot=command-input-wrapper]:h-auto">{children}</Command>
  </DialogContent>
)

export type ModelSelectorDialogProps = ComponentProps<typeof CommandDialog>

export const ModelSelectorDialog = (props: ModelSelectorDialogProps) => <CommandDialog {...props} />

export type ModelSelectorInputProps = ComponentProps<typeof CommandInput>

export const ModelSelectorInput = ({ className, ...props }: ModelSelectorInputProps) => (
  <CommandInput className={cn("h-auto py-3.5", className)} {...props} />
)

export type ModelSelectorListProps = ComponentProps<typeof CommandList>

export const ModelSelectorList = (props: ModelSelectorListProps) => <CommandList {...props} />

export type ModelSelectorEmptyProps = ComponentProps<typeof CommandEmpty>

export const ModelSelectorEmpty = (props: ModelSelectorEmptyProps) => <CommandEmpty {...props} />

export type ModelSelectorGroupProps = ComponentProps<typeof CommandGroup>

export const ModelSelectorGroup = (props: ModelSelectorGroupProps) => <CommandGroup {...props} />

export type ModelSelectorItemProps = ComponentProps<typeof CommandItem>

export const ModelSelectorItem = (props: ModelSelectorItemProps) => <CommandItem {...props} />

export type ModelSelectorShortcutProps = ComponentProps<typeof CommandShortcut>

export const ModelSelectorShortcut = (props: ModelSelectorShortcutProps) => <CommandShortcut {...props} />

export type ModelSelectorSeparatorProps = ComponentProps<typeof CommandSeparator>

export const ModelSelectorSeparator = (props: ModelSelectorSeparatorProps) => <CommandSeparator {...props} />

export type ModelSelectorLogoProps = Omit<ComponentProps<"img">, "src" | "alt"> & {
  provider:
    | "moonshotai-cn"
    | "lucidquery"
    | "moonshotai"
    | "zai-coding-plan"
    | "alibaba"
    | "xai"
    | "vultr"
    | "nvidia"
    | "upstage"
    | "groq"
    | "github-copilot"
    | "mistral"
    | "vercel"
    | "nebius"
    | "deepseek"
    | "alibaba-cn"
    | "google-vertex-anthropic"
    | "venice"
    | "chutes"
    | "cortecs"
    | "github-models"
    | "togetherai"
    | "azure"
    | "baseten"
    | "huggingface"
    | "opencode"
    | "fastrouter"
    | "google"
    | "google-vertex"
    | "cloudflare-workers-ai"
    | "inception"
    | "wandb"
    | "openai"
    | "zhipuai-coding-plan"
    | "perplexity"
    | "openrouter"
    | "zenmux"
    | "v0"
    | "iflowcn"
    | "synthetic"
    | "deepinfra"
    | "zhipuai"
    | "submodel"
    | "zai"
    | "inference"
    | "requesty"
    | "morph"
    | "lmstudio"
    | "anthropic"
    | "aihubmix"
    | "fireworks-ai"
    | "modelscope"
    | "llama"
    | "scaleway"
    | "amazon-bedrock"
    | "cerebras"
    // oxlint-disable-next-line typescript-eslint(ban-types) -- intentional pattern for autocomplete-friendly string union
    | (string & {})
}

export const ModelSelectorLogo = ({ provider, className, ...props }: ModelSelectorLogoProps) => (
  <img
    {...props}
    alt={`${provider} logo`}
    className={cn("size-3 dark:invert", className)}
    height={12}
    src={`https://models.dev/logos/${provider}.svg`}
    width={12}
  />
)

export type ModelSelectorLogoGroupProps = ComponentProps<"div">

export const ModelSelectorLogoGroup = ({ className, ...props }: ModelSelectorLogoGroupProps) => (
  <div
    className={cn(
      "flex shrink-0 items-center -space-x-1 [&>img]:rounded-full [&>img]:bg-background [&>img]:p-px [&>img]:ring-1 dark:[&>img]:bg-foreground",
      className,
    )}
    {...props}
  />
)

export type ModelSelectorNameProps = ComponentProps<"span">

/**
 * 模型名（行内最主要的信息，优先占宽）。
 *
 * `min-w-0` 是必须的：flex 子项的 `min-width: auto` 会按内容撑住不肯缩，
 * 一旦同一行还有 `provider/model` 这种长串，被挤扁的就是名字（踩过）。
 */
export const ModelSelectorName = ({ className, ...props }: ModelSelectorNameProps) => (
  <span className={cn("min-w-0 flex-1 truncate text-left", className)} {...props} />
)
