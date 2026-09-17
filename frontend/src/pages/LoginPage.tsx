import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Form, Input, message } from 'antd'
import { authApi } from '../api'
import { ApiError } from '../api/client'
import { setAuth } from '../auth'
import { BrandLogo } from '../components/BrandLogo'

export default function LoginPage() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)

  return (
    <div className="kh-login">
      <Card className="kh-login-card">
        <div className="kh-login-title">
          <BrandLogo size={40} />
          <h1>Knowledge Hub</h1>
          <p>Sign in to access documents, search, chat, and graph views</p>
        </div>
        <Form
          layout="vertical"
          initialValues={{ username: 'user', password: '123456' }}
          onFinish={async (values: { username: string; password: string }) => {
            setLoading(true)
            try {
              const result = await authApi.login(values.username, values.password)
              setAuth({
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                user: result.userInfo,
              })
              navigate('/dashboard', { replace: true })
            } catch (error) {
              message.error(error instanceof ApiError ? error.message : 'Sign-in failed')
            } finally {
              setLoading(false)
            }
          }}
        >
          <Form.Item name="username" label="Username" rules={[{ required: true }]}>
            <Input size="large" placeholder="Username" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password size="large" placeholder="Password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            Sign in
          </Button>
        </Form>
      </Card>
    </div>
  )
}
