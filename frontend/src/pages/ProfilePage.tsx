import { useEffect, useState } from 'react'
import { Button, Card, Col, Form, Input, Row, Statistic, Tag, message } from 'antd'
import { teamApi, userApi } from '../api'
import { ApiError } from '../api/client'
import type { TeamItem, UserStats } from '../types'
import { updateUser, useAuth } from '../auth'

export default function ProfilePage() {
  const user = useAuth()
  const [stats, setStats] = useState<UserStats | null>(null)
  const [teams, setTeams] = useState<TeamItem[]>([])
  const [profileForm] = Form.useForm()
  const [pwdForm] = Form.useForm()

  useEffect(() => {
    userApi.stats().then(setStats).catch(() => undefined)
    teamApi.mine().then(setTeams).catch(() => undefined)
    profileForm.setFieldsValue({
      realName: user?.realName,
      email: user?.email,
    })
  }, [user, profileForm])

  return (
    <div className="kh-page">
      <Row gutter={16}>
        <Col span={8}>
          <Statistic title="My documents" value={stats?.documentCount ?? 0} />
        </Col>
        <Col span={8}>
          <Statistic title="Views" value={stats?.viewCount ?? 0} />
        </Col>
        <Col span={8}>
          <Statistic title="Likes" value={stats?.likeCount ?? 0} />
        </Col>
      </Row>
      <Card title="Profile" style={{ marginTop: 24 }}>
        <Form
          form={profileForm}
          layout="vertical"
          style={{ maxWidth: 420 }}
          onFinish={async (values: { realName?: string; email?: string }) => {
            try {
              await userApi.updateMe(values)
              if (user) {
                updateUser({ ...user, realName: values.realName, email: values.email })
              }
              message.success('Updated')
            } catch (error) {
              message.error(error instanceof ApiError ? error.message : 'Update failed')
            }
          }}
        >
          <Form.Item label="Username">
            <Input disabled value={user?.username} />
          </Form.Item>
          <Form.Item label="Teams">
            {teams.length ? (
              <div>
                {teams.map((team) => (
                  <Tag key={team.id}>{team.teamName}</Tag>
                ))}
              </div>
            ) : (
              <span style={{ color: '#8c8c8c' }}>Not a member of any team</span>
            )}
          </Form.Item>
          <Form.Item name="realName" label="Name">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            Save profile
          </Button>
        </Form>
      </Card>
      <Card title="Change password" style={{ marginTop: 16 }}>
        <Form
          form={pwdForm}
          layout="vertical"
          style={{ maxWidth: 420 }}
          onFinish={async (values: { oldPassword: string; newPassword: string }) => {
            try {
              await userApi.changePassword(values.oldPassword, values.newPassword)
              message.success('Password changed')
              pwdForm.resetFields()
            } catch (error) {
              message.error(error instanceof ApiError ? error.message : 'Change failed')
            }
          }}
        >
          <Form.Item name="oldPassword" label="Current password" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="newPassword" label="New password" rules={[{ required: true, min: 6 }]}>
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            Change password
          </Button>
        </Form>
      </Card>
    </div>
  )
}
