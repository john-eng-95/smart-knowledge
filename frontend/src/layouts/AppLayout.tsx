import { useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  ApartmentOutlined,
  BellOutlined,
  ClusterOutlined,
  FileTextOutlined,
  HomeOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  ReadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Avatar, Badge, Dropdown, Layout, Menu, Tag, theme } from 'antd'
import type { MenuProps } from 'antd'
import { authApi, teamApi } from '../api'
import { clearAuth, updateUser, useAuth } from '../auth'
import { can, displayName, isAdmin, isReviewer } from '../utils'
import { BrandLogo } from '../components/BrandLogo'
import type { TeamItem } from '../types'

const { Header, Sider, Content } = Layout

type MenuItem = NonNullable<MenuProps['items']>[number]

export default function AppLayout() {
  const user = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [myTeams, setMyTeams] = useState<TeamItem[]>([])
  const {
    token: { colorBgContainer },
  } = theme.useToken()

  useEffect(() => {
    authApi.me().then(updateUser).catch(() => undefined)
    teamApi.mine().then(setMyTeams).catch(() => undefined)
  }, [])

  const topKey = useMemo(() => {
    if (location.pathname.startsWith('/documents') || location.pathname.startsWith('/admin/reviews')) {
      return '/documents'
    }
    if (location.pathname.startsWith('/search')) return '/search'
    if (location.pathname.startsWith('/chat')) return '/chat'
    if (location.pathname.startsWith('/graph')) return '/graph'
    if (location.pathname.startsWith('/profile')) return '/profile'
    if (location.pathname.startsWith('/admin')) return '/admin'
    return '/dashboard'
  }, [location.pathname])

  const topItems = useMemo(() => {
    const items: MenuItem[] = [
      { key: '/dashboard', label: 'Dashboard', icon: <HomeOutlined /> },
    ]
    if (can(user, 'document:list')) {
      items.push({ key: '/documents', label: 'Documents', icon: <FileTextOutlined /> })
    }
    if (can(user, 'search')) {
      items.push({ key: '/search', label: 'Search', icon: <SearchOutlined /> })
      items.push({ key: '/chat', label: 'AI Assistant', icon: <MessageOutlined /> })
      items.push({ key: '/graph', label: 'Knowledge Graph', icon: <ClusterOutlined /> })
    }
    if (can(user, 'profile')) {
      items.push({ key: '/profile', label: 'Profile', icon: <UserOutlined /> })
    }
    if (isAdmin(user)) {
      items.push({ key: '/admin/users', label: 'Administration', icon: <SettingOutlined /> })
    }
    return items
  }, [user])

  const side = useMemo(() => {
    if (topKey === '/documents') {
      const items: MenuItem[] = [
        { key: '/documents', icon: <ReadOutlined />, label: 'Visible documents' },
        { key: '/documents/new', icon: <FileTextOutlined />, label: 'New document' },
      ]
      if (isReviewer(user)) {
        items.push({ key: '/admin/reviews', icon: <BellOutlined />, label: 'Review workspace' })
      }
      return { title: 'Documents', items }
    }
    if (topKey === '/search') {
      return {
        title: 'Search',
        items: [{ key: '/search', icon: <SearchOutlined />, label: 'Full-text search' }],
      }
    }
    if (topKey === '/chat') {
      return {
        title: 'AI Assistant',
        items: [{ key: '/chat', icon: <MessageOutlined />, label: 'Knowledge chat' }],
      }
    }
    if (topKey === '/graph') {
      return {
        title: 'Knowledge Graph',
        items: [
          { key: '/graph', icon: <ApartmentOutlined />, label: 'Graph overview' },
        ],
      }
    }
    if (topKey === '/profile') {
      return {
        title: 'Profile',
        items: [{ key: '/profile', icon: <UserOutlined />, label: 'Account details' }],
      }
    }
    if (topKey === '/admin') {
      return {
        title: 'Administration',
        items: [
          { key: '/admin/users', icon: <UserOutlined />, label: 'Users' },
          { key: '/admin/roles', icon: <SafetyCertificateOutlined />, label: 'Roles and permissions' },
          { key: '/admin/teams', icon: <TeamOutlined />, label: 'Teams' },
        ],
      }
    }
    return {
      title: 'Dashboard',
      items: [{ key: '/dashboard', icon: <HomeOutlined />, label: 'Work overview' }],
    }
  }, [topKey, user])

  return (
    <Layout className="kh-root">
      <Header className="kh-header" style={{ background: colorBgContainer }}>
        <div className="kh-logo" onClick={() => navigate('/dashboard')}>
          <BrandLogo />
          <span className="kh-logo-text">Knowledge Hub</span>
        </div>
        <Menu
          className="kh-top-menu"
          mode="horizontal"
          selectedKeys={[topKey === '/admin' ? '/admin/users' : topKey]}
          items={topItems}
          onClick={({ key }) => navigate(key)}
        />
        <div className="kh-header-right">
          {isReviewer(user) ? (
            <Badge size="small" className="kh-bell">
              <BellOutlined
                style={{ fontSize: 18, cursor: 'pointer' }}
                onClick={() => navigate('/admin/reviews')}
              />
            </Badge>
          ) : null}
          <Dropdown
            menu={{
              items: [
                ...(can(user, 'profile')
                  ? [
                      { key: 'profile', label: 'Profile' },
                      { type: 'divider' as const },
                    ]
                  : []),
                { key: 'logout', label: 'Sign out' },
              ],
              onClick: ({ key }) => {
                if (key === 'profile') navigate('/profile')
                if (key === 'logout') {
                  authApi.logout().catch(() => undefined)
                  clearAuth()
                  navigate('/login')
                }
              },
            }}
          >
            <div className="kh-user">
              <Avatar size={28} icon={<UserOutlined />} src={user?.avatar || undefined} />
              <span>{displayName(user)}</span>
              {myTeams.slice(0, 2).map((team) => (
                <Tag key={team.id} style={{ marginInlineEnd: 0 }}>
                  {team.teamName}
                </Tag>
              ))}
            </div>
          </Dropdown>
        </div>
      </Header>
      <Layout>
        <Sider
          className="kh-sider"
          theme="light"
          width={220}
          collapsedWidth={64}
          collapsible
          collapsed={collapsed}
          trigger={null}
        >
          {!collapsed ? <div className="kh-sider-title">{side.title}</div> : null}
          <Menu
            mode="inline"
            selectedKeys={[location.pathname]}
            items={side.items}
            onClick={({ key }) => navigate(key)}
          />
          <div className="kh-sider-bottom" onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            {!collapsed ? <span>Collapse menu</span> : null}
          </div>
        </Sider>
        <Content className="kh-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
