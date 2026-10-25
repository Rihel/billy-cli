"use client"

import { cn } from "#lib/utils.ts"
import { Handle, MarkerType, Position, type Edge, type Node, type NodeProps } from "@xyflow/react"
import { useEffect, useMemo, useRef } from "react"

import { Canvas } from "../canvas.tsx"
import { Controls } from "../controls.tsx"
import { layoutXflow, XFLOW_NODE_SIZE } from "./xflow-layout.ts"
import type { XflowEdge, XflowNode, XflowNodeKind } from "./fence-spec.ts"

/**
 * 流程图画布（只有这个文件碰 `@xyflow/react`）。
 *
 * 拆成独立文件是为了**按需加载**：React Flow 与它的样式一起有几百 KB，
 * 不该因为会话里可能出现流程图就压进首屏包 —— `xflow-fence` 用 `lazy()` 引它。
 */

interface FlowNodeData extends Record<string, unknown> {
  label: string
  description?: string
  kind: XflowNodeKind
}

export interface XflowCanvasProps {
  /** 未排版的节点：位置在这里算（dagre 与本组件一起按需加载，不进首屏包） */
  nodes: XflowNode[]
  edges: XflowEdge[]
  direction: "LR" | "TB"
  /** 定高模式的高度（由上层按内容尺寸算好，夹在合理区间里）；`fill` 为真时忽略 */
  height?: number
  /** 撑满父容器（全屏查看用）—— 父容器必须自己有高度 */
  fill?: boolean
  /** 排版完成后回报内容尺寸（上层据此决定容器高度，避免先给一个拍脑袋的高度再跳） */
  onContentSize?: (size: { width: number; height: number }) => void
  /**
   * 可交互：允许拖动画布平移、并显示缩放控件。
   *
   * 会话里那张图保持只读（滚轮缩放即可，拖动会和页面滚动抢手势），全屏里才打开 ——
   * 大图必须能拖着看，否则只能靠缩放一点点找。
   */
  interactive?: boolean
}

/**
 * 节点卡片。
 *
 * 没有复用 `ai-elements/node`：那个组件把 Handle 固定成左右两侧，
 * 而 `TB` 方向的图连线要从上下进出，硬用会让线绕一大圈。
 */
const createFlowNode = (direction: "LR" | "TB") => {
  const targetPosition = direction === "LR" ? Position.Left : Position.Top
  const sourcePosition = direction === "LR" ? Position.Right : Position.Bottom

  const FlowNode = ({ data }: NodeProps) => {
    const { label, description, kind } = data as FlowNodeData
    return (
      <div
        className={cn(
          "flex flex-col justify-center rounded-lg border px-3 py-2",
          kind === "start" || kind === "end" ? "border-border bg-muted" : "border-border bg-card",
          kind === "decision" && "border-primary/50",
        )}
        style={{ width: XFLOW_NODE_SIZE.width, minHeight: XFLOW_NODE_SIZE.height }}
      >
        <Handle className="size-1.5 border-0 bg-border" position={targetPosition} type="target" />
        <p className="truncate font-medium text-[13px] text-foreground">{label}</p>
        {description ? <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{description}</p> : null}
        <Handle className="size-1.5 border-0 bg-border" position={sourcePosition} type="source" />
      </div>
    )
  }

  FlowNode.displayName = "XflowNodeCard"
  return FlowNode
}

export const XflowCanvas = ({
  nodes,
  edges,
  direction,
  height,
  fill = false,
  interactive = false,
  onContentSize,
}: XflowCanvasProps) => {
  const nodeTypes = useMemo(() => ({ flow: createFlowNode(direction) }), [direction])

  const layout = useMemo(() => layoutXflow({ nodes, edges, direction }), [nodes, edges, direction])
  const placed = layout.nodes

  // 回调放进 ref：调用方每次渲染都传新函数，直接进依赖会把 effect 变成每次都跑
  const onContentSizeRef = useRef(onContentSize)
  onContentSizeRef.current = onContentSize
  useEffect(() => {
    onContentSizeRef.current?.({ width: layout.width, height: layout.height })
  }, [layout])

  const flowNodes = useMemo<Node[]>(
    () =>
      placed.map((node) => ({
        id: node.id,
        type: "flow",
        position: { x: node.x, y: node.y },
        data: { label: node.label, description: node.description, kind: node.kind },
        draggable: false,
        connectable: false,
        selectable: false,
      })),
    [placed],
  )

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge, index) => ({
        id: `e${index}-${edge.from}-${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: "smoothstep",
        label: edge.label,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: { stroke: "var(--border)" },
        labelStyle: { fill: "var(--muted-foreground)", fontSize: 11 },
        labelBgStyle: { fill: "var(--sidebar)" },
      })),
    [edges],
  )

  return (
    <div
      className={cn("w-full overflow-hidden rounded-lg border border-border bg-sidebar", fill && "h-full")}
      style={fill ? undefined : { height }}
    >
      <Canvas
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        nodesConnectable={false}
        nodesDraggable={false}
        nodeTypes={nodeTypes}
        nodes={flowNodes}
        edges={flowEdges}
        panOnDrag={interactive}
      >
        {interactive ? <Controls /> : null}
      </Canvas>
    </div>
  )
}
