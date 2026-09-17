import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Empty, Form, Input, Select, Spin, Switch, message } from 'antd'
import { documentApi, teamApi } from '../api'
import { ApiError } from '../api/client'
import type { DocumentItem, TeamItem } from '../types'
import { useAuth } from '../auth'
import { canWriteDocument, flattenTeams, isAdmin } from '../utils'

export default function DocumentEditPage() {
  const { id } = useParams()
  const isNew = !id
  const navigate = useNavigate()
  const user = useAuth()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(!isNew)
  const [forbidden, setForbidden] = useState(false)
  const [teams, setTeams] = useState<TeamItem[]>([])
  const [doc, setDoc] = useState<DocumentItem | null>(null)

  useEffect(() => {
    const req = isAdmin(user)
      ? teamApi.tree().then(flattenTeams)
      : teamApi.mine()
    req.then(setTeams).catch(() => setTeams([]))
  }, [user])

  useEffect(() => {
    if (!id) return
    documentApi
      .get(id)
      .then((next) => {
        if (!canWriteDocument(user, next)) {
          setForbidden(true)
          message.error('You do not have permission to edit this document')
          return
        }
        setDoc(next)
        form.setFieldsValue({
          title: next.title,
          summary: next.summary,
          tags: next.tags,
          isPublic: next.isPublic,
          teamId: next.teamId || undefined,
          content: next.content,
        })
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 403) {
          setForbidden(true)
          message.error('You do not have permission to view this document')
        } else {
          message.error(error instanceof ApiError ? error.message : 'Failed to load document')
        }
      })
      .finally(() => setLoading(false))
  }, [id, form, user])

  const teamOptions = useMemo(() => {
    const options = teams.map((team) => ({
      value: team.id,
      label: team.teamName,
    }))
    if (doc?.teamId && !options.some((item) => item.value === doc.teamId)) {
      options.push({ value: doc.teamId, label: 'Current team' })
    }
    return options
  }, [teams, doc?.teamId])

  if (loading) {
    return (
      <div className="kh-page">
        <Spin />
      </div>
    )
  }

  if (forbidden) {
    return (
      <div className="kh-page">
        <Empty description="You do not have permission to edit this document">
          <Button onClick={() => navigate('/documents')}>Back to documents</Button>
        </Empty>
      </div>
    )
  }

  return (
    <div className="kh-page">
      <h2 style={{ marginTop: 0 }}>{isNew ? 'New document' : 'Edit document'}</h2>
      <p className="kh-access-hint">
        Public: visible to all signed-in users. Team: visible to team members after publishing. Neither: visible only to you.
      </p>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ isPublic: false, content: '' }}
        onFinish={async (values: {
          title: string
          summary?: string
          tags?: string
          isPublic: boolean
          teamId?: string
          content: string
        }) => {
          try {
            const payload = {
              title: values.title,
              content: values.content,
              summary: values.summary || undefined,
              tags: values.tags || undefined,
              isPublic: values.isPublic,
              teamId: values.teamId || null,
            }
            if (isNew) {
              const created = await documentApi.create({
                ...payload,
                status: 0,
              })
              message.success('Saved as draft')
              navigate(`/documents/${created.id}`)
            } else if (id) {
              await documentApi.update(id, payload)
              message.success('Saved')
              navigate(`/documents/${id}`)
            }
          } catch (error) {
            message.error(error instanceof ApiError ? error.message : 'Save failed')
          }
        }}
      >
        <Form.Item name="title" label="Title" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="summary" label="Summary">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="tags" label="Tags">
          <Input placeholder="Comma-separated, e.g. SOP, release" />
        </Form.Item>
        <Form.Item
          name="isPublic"
          label="Public"
          valuePropName="checked"
          extra="When enabled, published documents are visible to all signed-in users."
        >
          <Switch />
        </Form.Item>
        <Form.Item
          name="teamId"
          label="Team"
          extra={
            teamOptions.length
              ? 'Visible to team members after publishing, even when not public.'
              : 'You are not a member of any team. Only public or private visibility is available.'
          }
        >
          <Select
            allowClear
            placeholder="Leave empty for private visibility when not public"
            options={teamOptions}
            disabled={!teamOptions.length}
          />
        </Form.Item>
        <Form.Item name="content" label="Content (Markdown)" rules={[{ required: true }]}>
          <Input.TextArea rows={18} />
        </Form.Item>
        <Button type="primary" htmlType="submit">
          Save
        </Button>
        <Button style={{ marginLeft: 8 }} onClick={() => navigate(-1)}>
          Cancel
        </Button>
      </Form>
    </div>
  )
}
