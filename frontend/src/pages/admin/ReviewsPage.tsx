import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Input, Modal, Select, Space, Table, Tag, message } from 'antd'
import { documentApi } from '../../api'
import { ApiError } from '../../api/client'
import type { ReviewTask } from '../../types'
import { formatTime } from '../../utils'

export default function ReviewsPage() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const [items, setItems] = useState<ReviewTask[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [task, setTask] = useState<ReviewTask | null>(null)
  const [action, setAction] = useState<'approve' | 'reject'>('approve')
  const [comment, setComment] = useState('')

  async function load(nextPage = page) {
    setLoading(true)
    try {
      const res = await documentApi.reviewTasks({ status, page: nextPage, pageSize: 10 })
      setItems(res.items)
      setTotal(res.total)
      setPage(nextPage)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Failed to load review tasks')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(1)
  }, [status])

  return (
    <div className="kh-page">
      <Space style={{ marginBottom: 16 }}>
        <Select
          value={status}
          style={{ width: 160 }}
          onChange={setStatus}
          options={[
            { value: 'pending', label: 'Pending' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
          ]}
        />
        <Button onClick={() => void load(1)}>Refresh</Button>
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{ current: page, pageSize: 10, total, onChange: (p) => void load(p) }}
        columns={[
          {
            title: 'Document',
            dataIndex: 'documentId',
            render: (id: string) => <Link to={`/documents/${id}`}>{id}</Link>,
          },
          {
            title: 'Result',
            dataIndex: 'reviewResult',
            render: (v: number | null) =>
              v == null ? <Tag>Pending</Tag> : v === 1 ? <Tag color="success">Approved</Tag> : <Tag color="error">Rejected</Tag>,
          },
          { title: 'Comment', dataIndex: 'reviewComment' },
          { title: 'Submitted', dataIndex: 'createdAt', render: formatTime },
          {
            title: 'Actions',
            render: (_: unknown, row: ReviewTask) =>
              row.reviewResult == null ? (
                <Space>
                  <a
                    onClick={() => {
                      setTask(row)
                      setAction('approve')
                      setComment('The content meets the requirements and is approved for publication.')
                    }}
                  >
                    Approve
                  </a>
                  <a
                    onClick={() => {
                      setTask(row)
                      setAction('reject')
                      setComment('')
                    }}
                  >
                    Reject
                  </a>
                </Space>
              ) : (
                '-'
              ),
          },
        ]}
      />
      <Modal
        title={action === 'approve' ? 'Approve review' : 'Reject review'}
        open={Boolean(task)}
        onCancel={() => setTask(null)}
        onOk={async () => {
          if (!task) return
          try {
            if (action === 'approve') {
              await documentApi.approve(task.id, comment || undefined)
            } else {
              if (!comment.trim()) {
                message.error('A comment is required when rejecting a document')
                return
              }
              await documentApi.reject(task.id, comment.trim())
            }
            message.success('Submitted')
            setTask(null)
            void load()
          } catch (error) {
            message.error(error instanceof ApiError ? error.message : 'Operation failed')
          }
        }}
      >
        <Input.TextArea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Modal>
    </div>
  )
}
