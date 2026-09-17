import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Checkbox, Input, Select, Space, Table, Tag, Upload, message } from 'antd'
import { documentApi } from '../api'
import { ApiError } from '../api/client'
import type { DocumentItem } from '../types'
import { useAuth } from '../auth'
import { DOC_STATUS, can, canWriteDocument, formatTime, visibilityMeta } from '../utils'
import { FileTypeIcon, fileTypeLabel } from '../components/FileTypeIcon'

export default function DocumentsPage() {
  const user = useAuth()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<number | undefined>()
  const [mineOnly, setMineOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [items, setItems] = useState<DocumentItem[]>([])
  const [loading, setLoading] = useState(false)
  const pageSize = 10

  async function load(nextPage = page) {
    setLoading(true)
    try {
      const res = await documentApi.list({
        page: nextPage,
        pageSize,
        title: title.trim() || undefined,
        status,
        authorId: mineOnly ? user?.userId : undefined,
      })
      setItems(res.items)
      setTotal(res.total)
      setPage(nextPage)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Failed to load documents')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(1)
  }, [])

  return (
    <div className="kh-page">
      <p className="kh-access-hint">
        The list shows only documents you can access: public, team-shared, or authored by you. Editing and publishing are available to authors and administrators.
      </p>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          allowClear
          placeholder="Search by title"
          style={{ width: 240 }}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onPressEnter={() => void load(1)}
        />
        <Select
          allowClear
          placeholder="Status"
          style={{ width: 140 }}
          value={status}
          onChange={setStatus}
          options={Object.entries(DOC_STATUS).map(([k, v]) => ({
            value: Number(k),
            label: v.label,
          }))}
        />
        <Checkbox
          checked={mineOnly}
          onChange={(e) => setMineOnly(e.target.checked)}
        >
          Mine only
        </Checkbox>
        <Button onClick={() => void load(1)}>Search</Button>
        {can(user, 'document:create') ? (
          <>
            <Button type="primary" onClick={() => navigate('/documents/new')}>
              New document
            </Button>
            <Upload
              showUploadList={false}
              beforeUpload={async (file) => {
                const form = new FormData()
                form.append('file', file)
                try {
                  const res = await documentApi.uploadParse(form)
                  message.success('Parsed as a draft. Set public or team visibility on the edit page.')
                  navigate(`/documents/${res.documentId}/edit`)
                } catch (error) {
                  message.error(error instanceof ApiError ? error.message : 'Upload failed')
                }
                return false
              }}
            >
              <Button>Upload and parse</Button>
            </Upload>
          </>
        ) : null}
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{ current: page, pageSize, total, onChange: (p) => void load(p) }}
        columns={[
          {
            title: 'Title',
            dataIndex: 'title',
            render: (value: string, row: DocumentItem) => (
              <a
                onClick={() => navigate(`/documents/${row.id}`)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                <FileTypeIcon name={row.title} />
                {value}
              </a>
            ),
          },
          {
            title: 'File type',
            dataIndex: 'title',
            width: 100,
            render: (title: string) => fileTypeLabel(title),
          },
          {
            title: 'Status',
            dataIndex: 'status',
            width: 100,
            render: (s: number) => <Tag color={DOC_STATUS[s]?.color}>{DOC_STATUS[s]?.label}</Tag>,
          },
          {
            title: 'Visibility',
            width: 110,
            render: (_: unknown, row: DocumentItem) => {
              const vis = visibilityMeta(row)
              return <Tag color={vis.color}>{vis.label}</Tag>
            },
          },
          { title: 'Updated', dataIndex: 'updatedAt', width: 180, render: formatTime },
          {
            title: 'Actions',
            width: 160,
            render: (_: unknown, row: DocumentItem) => {
              const writable = can(user, 'document:edit') && canWriteDocument(user, row)
              return (
                <Space>
                  {writable ? (
                    <a onClick={() => navigate(`/documents/${row.id}/edit`)}>Edit</a>
                  ) : null}
                  {writable && row.status === 0 ? (
                    <a
                      onClick={async () => {
                        try {
                          await documentApi.publish(row.id)
                          message.success('Submitted for publication')
                          void load()
                        } catch (error) {
                          message.error(error instanceof ApiError ? error.message : 'Publish failed')
                        }
                      }}
                    >
                      Publish
                    </a>
                  ) : null}
                </Space>
              )
            },
          },
        ]}
      />
    </div>
  )
}
