import { useEffect, useState } from 'react'
import { Button, Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd'
import { roleApi, userApi } from '../../api'
import { ApiError } from '../../api/client'
import type { RoleItem, UserVO } from '../../types'
import { formatTime } from '../../utils'

export default function UsersPage() {
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [items, setItems] = useState<UserVO[]>([])
  const [roles, setRoles] = useState<RoleItem[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [roleUser, setRoleUser] = useState<UserVO | null>(null)
  const [roleCodes, setRoleCodes] = useState<string[]>([])
  const [pwdUser, setPwdUser] = useState<UserVO | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [form] = Form.useForm()

  async function load(nextPage = page) {
    setLoading(true)
    try {
      const res = await userApi.page({
        page: nextPage,
        pageSize: 10,
        keyword: keyword.trim() || undefined,
      })
      setItems(res.items)
      setTotal(res.total)
      setPage(nextPage)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(1)
    roleApi.list().then(setRoles).catch(() => undefined)
  }, [])

  return (
    <div className="kh-page">
      <Space style={{ marginBottom: 16 }}>
        <Input
          placeholder="Username / name / email"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={() => void load(1)}
        />
        <Button onClick={() => void load(1)}>Search</Button>
        <Button
          type="primary"
          onClick={() => {
            form.resetFields()
            setCreateOpen(true)
          }}
        >
          New user
        </Button>
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{ current: page, pageSize: 10, total, onChange: (p) => void load(p) }}
        columns={[
          { title: 'Username', dataIndex: 'username' },
          { title: 'Name', dataIndex: 'realName' },
          { title: 'Email', dataIndex: 'email' },
          {
            title: 'Roles',
            dataIndex: 'roleCodes',
            render: (codes: string[]) => codes?.map((c) => <Tag key={c}>{c}</Tag>),
          },
          {
            title: 'Status',
            dataIndex: 'status',
            render: (s: number) => (s === 1 ? 'Enabled' : 'Disabled'),
          },
          { title: 'Last login', dataIndex: 'lastLoginAt', render: formatTime },
          {
            title: 'Actions',
            render: (_: unknown, row: UserVO) => (
              <Space>
                <a
                  onClick={() => {
                    setPwdUser(row)
                    setNewPassword('')
                  }}
                >
                  Reset password
                </a>
                <a
                  onClick={() => {
                    setRoleUser(row)
                    setRoleCodes(row.roleCodes || [])
                  }}
                >
                  Roles
                </a>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title="New user"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values: {
            username: string
            password: string
            realName?: string
            email?: string
            roleCodes?: string[]
          }) => {
            try {
              await userApi.create(values)
              message.success('Created')
              setCreateOpen(false)
              void load(1)
            } catch (error) {
              message.error(error instanceof ApiError ? error.message : 'Creation failed')
            }
          }}
        >
          <Form.Item name="username" label="Username" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true, min: 6 }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="realName" label="Name">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email">
            <Input />
          </Form.Item>
          <Form.Item name="roleCodes" label="Roles">
            <Select
              mode="multiple"
              options={roles.map((r) => ({ value: r.roleCode, label: r.roleName }))}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={pwdUser ? `Reset password for ${pwdUser.username}` : 'Reset password'}
        open={Boolean(pwdUser)}
        onCancel={() => setPwdUser(null)}
        onOk={async () => {
          if (!pwdUser) return
          if (newPassword.length < 6) {
            message.error('Password must be at least 6 characters')
            return
          }
          try {
            await userApi.resetPassword(pwdUser.id, newPassword)
            message.success('Password reset')
            setPwdUser(null)
          } catch (error) {
            message.error(error instanceof ApiError ? error.message : 'Reset failed')
          }
        }}
      >
        <Input.Password
          placeholder="New password, at least 6 characters"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </Modal>
      <Modal
        title="Assign roles"
        open={Boolean(roleUser)}
        onCancel={() => setRoleUser(null)}
        onOk={async () => {
          if (!roleUser || !roleCodes.length) {
            message.error('Select at least one role')
            return
          }
          try {
            await userApi.assignRoles(roleUser.id, roleCodes)
            message.success('Roles updated')
            setRoleUser(null)
            void load()
          } catch (error) {
            message.error(error instanceof ApiError ? error.message : 'Update failed')
          }
        }}
      >
        <Select
          mode="multiple"
          style={{ width: '100%' }}
          value={roleCodes}
          onChange={setRoleCodes}
          options={roles.map((r) => ({ value: r.roleCode, label: r.roleName }))}
        />
      </Modal>
    </div>
  )
}
