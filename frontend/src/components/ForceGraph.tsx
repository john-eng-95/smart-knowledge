import { useEffect, useRef, type RefObject } from 'react'
import * as echarts from 'echarts'
import type { ECharts, EChartsOption } from 'echarts'
import type { GraphViewEdge, GraphViewNode } from '../types'

export interface GraphChartHandle {
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  exportPng: () => void
}

interface Props {
  nodes: GraphViewNode[]
  edges: GraphViewEdge[]
  onNodeClick?: (node: GraphViewNode) => void
  chartRef?: RefObject<GraphChartHandle | null>
}

const CATEGORIES = [
  { name: 'Documents', itemStyle: { color: '#1677ff' } },
  { name: 'Entities', itemStyle: { color: '#52c41a' } },
  { name: 'People', itemStyle: { color: '#fa8c16' } },
  { name: 'Organizations', itemStyle: { color: '#13c2c2' } },
  { name: 'Tags', itemStyle: { color: '#722ed1' } },
] as const

function categoryIndex(node: GraphViewNode) {
  if (node.kind === 'document') return 0
  if (node.kind === 'tag') return 4
  if (node.type === 'PERSON') return 2
  if (node.type === 'ORGANIZATION') return 3
  return 1
}

function symbolSize(node: GraphViewNode, degree: number) {
  if (node.kind === 'document') return 32
  if (node.kind === 'tag') return 16
  return 18 + Math.min(degree, 8)
}

function shortName(name: string) {
  return name.length > 8 ? `${name.slice(0, 8)}…` : name
}

function kindLabel(node: GraphViewNode) {
  if (node.kind === 'document') return 'Document'
  if (node.kind === 'tag') return 'Tag'
  if (node.type === 'PERSON') return 'Person'
  if (node.type === 'ORGANIZATION') return 'Organization'
  return node.type || 'Entity'
}

function edgeLineStyle(kind: GraphViewEdge['kind']) {
  // Curveness separates multiple edges that would otherwise overlap.
  if (kind === 'mentions') {
    return { color: '#1677ff', width: 1.8, type: 'solid' as const, curveness: 0.24, opacity: 0.9 }
  }
  if (kind === 'related') {
    return { color: '#8c8c8c', width: 1.3, type: 'dashed' as const, curveness: 0.28, opacity: 0.85 }
  }
  return { color: '#722ed1', width: 1.3, type: 'dashed' as const, curveness: 0.2, opacity: 0.8 }
}

function changeZoom(chart: ECharts | null, factor: number) {
  if (!chart) return
  const option = chart.getOption() as { series?: Array<{ zoom?: number }> }
  const current = Number(option.series?.[0]?.zoom ?? 1)
  const next = Math.min(4, Math.max(0.25, current * factor))
  chart.setOption({ series: [{ zoom: next }] })
}

function bindHandle(chartRef: Props['chartRef'], chart: ECharts) {
  if (!chartRef) return
  chartRef.current = {
    zoomIn: () => changeZoom(chart, 1.25),
    zoomOut: () => changeZoom(chart, 0.8),
    reset: () => chart.dispatchAction({ type: 'restore' }),
    exportPng: () => {
      const url = chart.getDataURL({
        type: 'png',
        pixelRatio: 2, // Export at 2x resolution for a sharper image.
        backgroundColor: '#fafafa',
      })
      const a = document.createElement('a')
      a.href = url
      a.download = 'knowledge-graph.png'
      a.click()
    },
  }
}

function buildOption(nodes: GraphViewNode[], edges: GraphViewEdge[]): EChartsOption {
  const degree = new Map<string, number>()
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item', // Show tooltips for hovered nodes and edges, not axes.
      confine: true, // Keep tooltips inside the chart bounds.
      formatter: (raw) => {
        const params = raw as {
          dataType?: string
          data?: { id?: string; name?: string; relation?: string }
        }
        if (params.dataType === 'edge') {
          return `<div style="padding:4px 2px">${params.data?.relation || 'Related'}</div>`
        }
        const node = nodes.find((n) => n.id === params.data?.id)
        if (!node) return params.data?.name ?? ''
        const desc = node.description
          ? `<div style="color:#8c8c8c;margin-top:4px;max-width:280px;white-space:normal">${node.description}</div>`
          : ''
        return `<div style="padding:4px 2px"><b>${node.name}</b><div style="color:#1677ff;margin-top:4px">${kindLabel(node)}</div>${desc}</div>`
      },
    },
    series: [
      {
        type: 'graph',
        layout: 'force', // Force layout repels nodes and pulls connected edges together.
        roam: true, // Allow wheel zooming and canvas panning.
        roamTrigger: 'global', // Allow panning from empty canvas space.
        draggable: true, // Allow nodes to be dragged.
        zoom: 1, // Initial zoom level.
        scaleLimit: { min: 0.25, max: 4 }, // Zoom limits.
        left: 40,
        right: 40,
        top: 24,
        bottom: 48, // Leave room for the legend and zoom controls.
        categories: [...CATEGORIES], // Legend categories determine node colors.
        data: nodes.map((node) => ({
          id: node.id,
          name: node.name,
          category: categoryIndex(node),
          symbolSize: symbolSize(node, degree.get(node.id) ?? 1), // Node size.
          label: {
            show: true,
            position: 'bottom' as const,
            distance: 8, // Gap between labels and nodes.
            color: '#434343',
            fontSize: node.kind === 'document' ? 12 : 11,
            fontWeight: node.kind === 'document' ? 600 : 400,
            formatter: () => shortName(node.name),
          },
        })),
        links: edges.map((edge) => ({
          source: edge.source,
          target: edge.target,
          relation: edge.relation,
          silent: true, // Keep edges from intercepting clicks or hover highlights.
          lineStyle: edgeLineStyle(edge.kind),
        })),
        force: {
          repulsion: 160, // Node repulsion; higher values spread nodes farther apart.
          gravity: 0.1, // Pull nodes toward the center.
          edgeLength: 70, // Ideal edge length.
          friction: 0.5, // Damping; higher values settle faster.
          layoutAnimation: false, // Disable entry animation for large graphs.
        },
        labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' }, // Hide or vertically shift overlapping labels.
        lineStyle: { opacity: 0.9 },
        emphasis: {
          focus: 'adjacency', // Highlight the selected node and adjacent edges/nodes.
          scale: 1.12, // Slightly enlarge nodes on hover.
          lineStyle: { width: 2.6 },
          label: { fontWeight: 700 },
        },
        blur: {
          // Dim non-adjacent elements when focus is set to adjacency.
          itemStyle: { opacity: 0.2 },
          lineStyle: { opacity: 0.08 },
          label: { opacity: 0.15 },
        },
        edgeSymbol: ['none', 'arrow'], // No marker at the start; draw an arrow at the end.
        edgeSymbolSize: [0, 8],
        edgeLabel: { show: false }, // Keep relation names in tooltips instead of on edges.
      },
    ],
  }
}

export default function ForceGraph({ nodes, edges, onNodeClick, chartRef }: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const clickRef = useRef(onNodeClick)
  const nodesRef = useRef(nodes)
  clickRef.current = onNodeClick
  nodesRef.current = nodes

  useEffect(() => {
    const el = elRef.current
    if (!el) return

    let chart: ECharts | null = null
    let disposed = false
    let lastSize = { w: 0, h: 0 }

    const render = () => {
      if (disposed || el.clientWidth < 80 || el.clientHeight < 80) return
      const sizeChanged = el.clientWidth !== lastSize.w || el.clientHeight !== lastSize.h
      lastSize = { w: el.clientWidth, h: el.clientHeight }
      if (!chart) {
        chart = echarts.init(el)
        chart.on('click', (params) => {
          if (params.dataType !== 'node') return
          const id = String((params.data as { id?: string }).id ?? '')
          const node = nodesRef.current.find((n) => n.id === id)
          if (node) clickRef.current?.(node)
        })
        bindHandle(chartRef, chart)
        chart.setOption(buildOption(nodes, edges), { notMerge: true })
        return
      }
      if (sizeChanged) chart.resize()
    }

    render()
    const ro = new ResizeObserver(render)
    ro.observe(el)

    return () => {
      disposed = true
      ro.disconnect()
      chart?.dispose()
      if (chartRef) chartRef.current = null
    }
  }, [chartRef, nodes, edges])

  return <div ref={elRef} className="kh-force-wrap" />
}

interface PieProps {
  items: Array<{ type: string; count: number }>
}

export function EntityTypePie({ items }: PieProps) {
  const elRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const chart = echarts.init(el)
    const data = items.length
      ? items.map((item) => ({ name: item.type, value: item.count }))
      : [{ name: 'No data', value: 0 }]
    chart.setOption({
      tooltip: { trigger: 'item' },
      series: [
        {
          type: 'pie',
          radius: ['42%', '68%'], // Inner and outer radii for the donut chart.
          center: ['50%', '50%'],
          avoidLabelOverlap: true, // Automatically separate overlapping labels.
          itemStyle: { borderColor: '#fff', borderWidth: 2 },
          label: { fontSize: 11, color: '#595959' },
          data,
        },
      ],
    } satisfies EChartsOption)
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.dispose()
    }
  }, [items])

  return <div ref={elRef} className="kh-type-pie" />
}
