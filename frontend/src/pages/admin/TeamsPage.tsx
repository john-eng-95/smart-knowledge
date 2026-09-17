import { useEffect, useState } from 'react'
import { Button, Form, Input, Modal, Popconfirm, Select, Space, Table, message } from 'antd'
import { teamApi, userApi } from '../../api'
import { ApiError } from '../../api/client'
import type { TeamItem } from '../../types'

interface MemberRow {
  userId: string
  username: string
  realName?: string
  memberRole?: string
}

export default function TeamsPage() {
  const [items, setItems] = useState<TeamItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [open, setOpen] = useState(false)
  const [membersFor, setMembersFor] = useState<TeamItem | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [selectedUserId, setSelectedUserId] = useState<string>()
  const [userOptions, setUserOptions] = useState<{ value: string; label: string }[]>([])
  const [searching, setSearching] = useState(false)
  const [form] = Form.useForm()

  async function load(nextPage = page) {
    try {
      const res = await teamApi.page({
        page: nextPage,
        pageSize: 10,
        keyword: keyword.trim() || undefined,
      })
      setItems(res.items)
      setTotal(res.total)
      setPage(nextPage)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Failed to load teams')
    }
  }

  async function loadMembers(teamId: string) {
    const rows = (await teamApi.members(teamId)) as MemberRow[]
    setMembers(rows)
    setItems((prev) =>
      prev.map((team) => (team.id === teamId ? { ...team, memberCount: rows.length } : team)),
    )
    return rows
  }

  async function searchUsers(query: string) {
    const kw = query.trim().toLowerCase()
    if (!kw) {
      setUserOptions([])
      return
    }
    setSearching(true)
    try {
      const res = await userApi.page({
        keyword: query.trim(),
        page: 1,
        pageSize: 20,
      })
      const taken = new Set(members.map((row) => row.userId))
      setUserOptions(
        res.items
          .filter(
            (user) =>
              !taken.has(user.id) && user.username.toLowerCase().includes(kw),
          )
          .map((user) => ({
            value: user.id,
            label: user.realName ? `${user.username}（${user.realName}）` : user.username,
          })),
      )
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'User search failed')
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    void load(1)
  }, [])

  return (
    <div className="kh-page">
      <Space style={{ marginBottom: 16 }}>
        <Input
          placeholder="Team name"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={() => void load(1)}
        />
        <Button onClick={() => void load(1)}>Search</Button>
        <Button type="primary" onClick={() => setOpen(true)}>
          New team
        </Button>
      </Space>
      <Table
        rowKey="id"
        dataSource={items}
        pagination={{ current: page, pageSize: 10, total, onChange: (p) => void load(p) }}
        columns={[
          { title: 'Name', dataIndex: 'teamName' },
          { title: 'Code', dataIndex: 'teamCode' },
          { title: 'Description', dataIndex: 'description' },
          { title: 'Members', dataIndex: 'memberCount' },
          {
            title: 'Actions',
            render: (_: unknown, row: TeamItem) => (
              <a
                onClick={async () => {
                  setMembersFor(row)
                  setSelectedUserId(undefined)
                  setUserOptions([])
                  try {
                    await loadMembers(row.id)
                  } catch (error) {
                    message.error(error instanceof ApiError ? error.message : 'Failed to load members')
                  }
                }}
              >
                Members
              </a>
            ),
          },
        ]}
      />
      <Modal title="New team" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values: { teamName: string; teamCode?: string; description?: string }) => {
            try {
              await teamApi.create(values)
              message.success('Created')
              setOpen(false)
              form.resetFields()
              void load(1)
            } catch (error) {
              message.error(error instanceof ApiError ? error.message : 'Creation failed')
            }
          }}
        >
          <Form.Item name="teamName" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="teamCode" label="Code">
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={membersFor ? `Members: ${membersFor.teamName}` : 'Members'}
        open={Boolean(membersFor)}
        onCancel={() => setMembersFor(null)}
        footer={null}
        width={640}
      >
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            showSearch={{
              filterOption: false,
              onSearch: (value) => void searchUsers(value),
            }}
            allowClear
            placeholder="Search by username"
            value={selectedUserId}
            options={userOptions}
            loading={searching}
            onChange={(value) => setSelectedUserId(value)}
            style={{ width: 280 }}
            notFoundContent={searching ? 'Searching…' : 'Enter a username to search'}
          />
          <Button
            type="primary"
            onClick={async () => {
              if (!membersFor || !selectedUserId) {
                message.warning('Search by username and select a member first')
                return
              }
              try {
                await teamApi.addMembers(membersFor.id, [selectedUserId])
                await loadMembers(membersFor.id)
                setSelectedUserId(undefined)
                setUserOptions([])
                message.success('Added')
              } catch (error) {
                message.error(error instanceof ApiError ? error.message : 'Add failed')
              }
            }}
          >
            Add
          </Button>
        </Space>
        <Table
          rowKey="userId"
          dataSource={members}
          pagination={false}
          columns={[
            { title: 'Username', dataIndex: 'username' },
            { title: 'Name', dataIndex: 'realName' },
            { title: 'Role', dataIndex: 'memberRole' },
            {
              title: 'Actions',
              width: 80,
              render: (_: unknown, row: MemberRow) => (
                <Popconfirm
                  title={`Remove ${row.username} from this team?`}
                  okText="Remove"
                  okType="danger"
                  cancelText="Cancel"
                  onConfirm={async () => {
                    if (!membersFor) return
                    try {
                      await teamApi.removeMembers(membersFor.id, [row.userId])
                      await loadMembers(membersFor.id)
                      message.success('Removed')
                    } catch (error) {
                      message.error(error instanceof ApiError ? error.message : 'Remove failed')
                    }
                  }}
                >
                  <a style={{ color: '#ff4d4f' }}>Remove</a>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  )
}
