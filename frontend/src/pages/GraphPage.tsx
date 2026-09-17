import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CompressOutlined,
  DownloadOutlined,
  MinusOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { Button, DatePicker, Empty, Input, Select, Space, Spin, message } from 'antd'
import { graphApi } from '../api'
import { ApiError } from '../api/client'
import ForceGraph, { EntityTypePie, type GraphChartHandle } from '../components/ForceGraph'
import type { GraphOverview, GraphViewNode } from '../types'
import { formatTime } from '../utils'

const emptyOverview: GraphOverview = {
  nodes: [],
  edges: [],
  stats: {
    nodeCount: 0,
    edgeCount: 0,
    documentCount: 0,
    entityCount: 0,
    tagCount: 0,
    mentionCount: 0,
    relatedCount: 0,
    entityTypes: [],
  },
  topEntities: [],
  recentNodes: [],
  entityTypes: [],
}

export default function GraphPage() {
  const navigate = useNavigate()
  const [keyword, setKeyword] = useState('')
  const [entityType, setEntityType] = useState<string>()
  const [from, setFrom] = useState<string>()
  const [to, setTo] = useState<string>()
  const [data, setData] = useState<GraphOverview>(emptyOverview)
  const [loading, setLoading] = useState(false)
  const [pickerKey, setPickerKey] = useState(0)
  const [selected, setSelected] = useState<GraphViewNode | null>(null)
  const chartRef = useRef<GraphChartHandle | null>(null)

  async function load(next?: {
    keyword?: string
    entityType?: string | null
    from?: string | null
    to?: string | null
  }) {
    setLoading(true)
    try {
      const res = await graphApi.overview({
        keyword: (next?.keyword ?? keyword).trim() || undefined,
        entityType: (next && 'entityType' in next ? next.entityType : entityType) || undefined,
        from: (next && 'from' in next ? next.from : from) || undefined,
        to: (next && 'to' in next ? next.to : to) || undefined,
        docLimit: 24,
      })
      setData(res)
      setSelected(null)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Failed to load graph')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const typeOptions = data.entityTypes.map((t) => ({ value: t, label: t }))

  return (
    <div className="kh-graph-layout">
      <div className="kh-graph-main">
        <div className="kh-graph-toolbar">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
            placeholder="Search the graph you are allowed to access…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => void load()}
            style={{ width: 240 }}
          />
          <Select
            allowClear
            placeholder="Node type"
            style={{ width: 150 }}
            value={entityType}
            onChange={(v) => {
              setEntityType(v)
              void load({ entityType: v ?? null })
            }}
            options={typeOptions}
          />
          <DatePicker.RangePicker
            key={pickerKey}
            onChange={(dates) => {
              setFrom(dates?.[0]?.toISOString())
              setTo(dates?.[1]?.toISOString())
            }}
          />
          <Button
            onClick={() => {
              setKeyword('')
              setEntityType(undefined)
              setFrom(undefined)
              setTo(undefined)
              setPickerKey((k) => k + 1)
              void load({
                keyword: '',
                entityType: null,
                from: null,
                to: null,
              })
            }}
          >
            Reset
          </Button>
          <Button type="primary" loading={loading} onClick={() => void load()}>
            Search
          </Button>
          <div style={{ flex: 1, color: '#8c8c8c', fontSize: 12 }}>
            Shows only documents and entities you are allowed to access
          </div>
          <Button icon={<DownloadOutlined />} onClick={() => chartRef.current?.exportPng()}>
            Export graph
          </Button>
        </div>
        <div className="kh-graph-canvas">
          {data.nodes.length ? (
            <ForceGraph
              nodes={data.nodes}
              edges={data.edges}
              chartRef={chartRef}
              onNodeClick={(node) => setSelected(node)}
            />
          ) : (
            <div className="kh-graph-empty">
              {loading ? (
                <Spin />
              ) : (
                <Empty description="No graph data is available. Publish documents to populate Neo4j." />
              )}
            </div>
          )}
          {loading && data.nodes.length ? (
            <div className="kh-graph-loading">
              <Spin />
            </div>
          ) : null}
          <div className="kh-graph-legend">
            <span>
              <i style={{ background: '#1677ff' }} /> Documents
            </span>
            <span>
              <i style={{ background: '#52c41a' }} /> Entities
            </span>
            <span>
              <i style={{ background: '#fa8c16' }} /> People
            </span>
            <span>
              <i style={{ background: '#13c2c2' }} /> Organizations
            </span>
            <span>
              <i style={{ background: '#722ed1' }} /> Tags
            </span>
            <span>
              <span className="kh-legend-line kh-legend-blue" /> Mentions
            </span>
            <span>
              <span className="kh-legend-dash kh-legend-grey" /> Related
            </span>
            <span>
              <span className="kh-legend-dash kh-legend-purple" /> Tagged
            </span>
          </div>
          <div className="kh-graph-zoom">
            <Button size="small" icon={<PlusOutlined />} onClick={() => chartRef.current?.zoomIn()} />
            <Button size="small" icon={<MinusOutlined />} onClick={() => chartRef.current?.zoomOut()} />
            <Button size="small" icon={<CompressOutlined />} onClick={() => chartRef.current?.reset()} />
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} />
          </div>
          <div className="kh-graph-hint">Drag nodes, zoom with the wheel, or click a document node to open its content.</div>
        </div>
      </div>
      <aside className="kh-graph-side">
        <div className="kh-graph-card">
          <h4>Graph statistics</h4>
          <div className="kh-graph-stats">
            <div>
              <b>{data.stats.documentCount}</b>
              <span>Document nodes</span>
            </div>
            <div>
              <b>{data.stats.entityCount}</b>
              <span>Entities</span>
            </div>
            <div>
              <b>{data.stats.relatedCount}</b>
              <span>Entity relations</span>
            </div>
            <div>
              <b>{data.stats.mentionCount}</b>
              <span>Document mentions</span>
            </div>
            <div>
              <b>{data.stats.tagCount}</b>
              <span>Current tags</span>
            </div>
            <div>
              <b>{data.stats.edgeCount}</b>
              <span>Graph edges</span>
            </div>
          </div>
        </div>
        <div className="kh-graph-card">
          <h4>Entity type distribution</h4>
          {data.stats.entityTypes.length ? (
            <EntityTypePie items={data.stats.entityTypes} />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No data" />
          )}
        </div>
        <div className="kh-graph-card">
          <h4>Top 5 entities</h4>
          {data.topEntities.length ? (
            <ol className="kh-graph-rank">
              {data.topEntities.map((e, i) => (
                <li key={e.name}>
                  <span className="kh-rank">{i + 1}</span>
                  <span className="kh-rank-name">{e.name}</span>
                  <span className="kh-rank-n">{e.degree}</span>
                </li>
              ))}
            </ol>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No data" />
          )}
        </div>
        <div className="kh-graph-card">
          <h4>Recently updated nodes</h4>
          {data.recentNodes.map((n) => (
            <div key={n.id} className="kh-graph-recent">
              <div>{n.name}</div>
              <small>{formatTime(n.updatedAt)}</small>
            </div>
          ))}
        </div>
        {selected ? (
          <div className="kh-graph-card">
            <h4>Selected node</h4>
            <Space direction="vertical" size={4}>
              <div>{selected.name}</div>
              <div style={{ color: '#8c8c8c', fontSize: 12 }}>
                {selected.kind === 'document'
                  ? 'Document'
                  : selected.kind === 'tag'
                    ? 'Tag'
                    : selected.type || 'Entity'}
              </div>
              {selected.description ? <div>{selected.description}</div> : null}
              {selected.documentId ? (
                <Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/documents/${selected.documentId}`)}>
                  Open document
                </Button>
              ) : null}
            </Space>
          </div>
        ) : null}
      </aside>
    </div>
  )
}
