import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, TouchEvent, WheelEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { DeleteOutlined, DownOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Button, Empty, Input, Space, Typography, message } from 'antd'
import { aiApi } from '../api'
import { ApiError } from '../api/client'
import { getAccessToken } from '../auth'
import {
  ChatMessageParts,
  historyToUIMessages,
  type KhUIMessage,
} from '../components/ChatMessageParts'
import type { ChatMessage, ChatSession } from '../types'
import { formatTime } from '../utils'

const CHAT_ID = 'kh-chat' // Reuse one useChat stream when navigating between chat views.

export default function ChatPage() {
  const navigate = useNavigate()
  const { modal } = App.useApp()
  const [params] = useSearchParams()
  const sessionId = params.get('session') || undefined

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [input, setInput] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef(sessionId)
  const loadedSessionRef = useRef<string | undefined>(undefined)
  /** Keep streaming output pinned to the bottom until the user scrolls away. */
  const pinBottomRef = useRef(true)
  /** Ignore scroll events caused by programmatic scrolling. */
  const autoScrollingRef = useRef(false)
  const scrollRafRef = useRef<number | null>(null)
  const touchYRef = useRef<number | null>(null)
  const [showJump, setShowJump] = useState(false)
  sessionIdRef.current = sessionId

  const transport = useMemo(
    () =>
      new DefaultChatTransport<KhUIMessage>({
        api: '/api/ai/chat/stream',
        headers: () => {
          const token = getAccessToken()
          const headers: Record<string, string> = {}
          if (token) headers.Authorization = `Bearer ${token}`
          return headers
        },
      }),
    [],
  )

  const { messages, sendMessage, setMessages, status, stop, error } = useChat<KhUIMessage>({
    id: CHAT_ID,
    transport,
    onData: (part) => {
      if (part.type !== 'data-session') return
      const nextId = part.data.sessionId
      if (!nextId || nextId === sessionIdRef.current) return
      loadedSessionRef.current = nextId
      navigate(`/chat?session=${nextId}`, { replace: true })
    },
    onFinish: () => {
      void loadSessions()
    },
    onError: (err) => {
      message.error(err.message || 'Request failed')
    },
  })

  const streaming = status === 'submitted' || status === 'streaming'
  const busy = streaming

  async function loadSessions() {
    try {
      const res = await aiApi.sessions()
      setSessions(res.items)
    } catch {
      /* Session list failures should not block chat. */
    }
  }

  useEffect(() => {
    void loadSessions()
  }, [])

  useEffect(() => {
    if (streaming) return
    if (!sessionId) {
      if (loadedSessionRef.current) {
        loadedSessionRef.current = undefined
        setMessages([])
      }
      return
    }
    if (loadedSessionRef.current === sessionId) return
    let cancelled = false
    loadedSessionRef.current = sessionId
    aiApi
      .messages(sessionId)
      .then((rows: ChatMessage[]) => {
        if (cancelled) return
        setMessages(historyToUIMessages(rows))
      })
      .catch((err) => {
        if (!cancelled) {
          loadedSessionRef.current = undefined
          message.error(err instanceof ApiError ? err.message : 'Failed to load session')
          navigate('/chat', { replace: true })
        }
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, streaming, navigate, setMessages])

  function gapToBottom(el: HTMLElement) {
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }

  function syncJumpButton() {
    const el = logRef.current
    const overflow = !!el && el.scrollHeight - el.clientHeight > 8
    const next = !pinBottomRef.current && overflow
    setShowJump((prev) => (prev === next ? prev : next))
  }

  function setPinned(next: boolean) {
    pinBottomRef.current = next
    if (!next && scrollRafRef.current != null) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = null
    }
    syncJumpButton()
  }

  function scrollToBottom() {
    const el = logRef.current
    if (!el || !pinBottomRef.current) return
    autoScrollingRef.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      autoScrollingRef.current = false
    })
  }

  function onLogScroll() {
    if (autoScrollingRef.current) return
    const el = logRef.current
    if (!el) return
    setPinned(gapToBottom(el) < 48)
  }

  /** Scrolling up releases the bottom pin; scrolling down near the bottom restores it. */
  function onLogWheel(e: WheelEvent<HTMLDivElement>) {
    if (e.deltaY < 0) {
      setPinned(false)
      return
    }
    const el = logRef.current
    if (el && gapToBottom(el) - e.deltaY < 48) setPinned(true)
  }

  function onLogTouchStart(e: TouchEvent<HTMLDivElement>) {
    touchYRef.current = e.touches[0]?.clientY ?? null
  }

  function onLogTouchMove(e: TouchEvent<HTMLDivElement>) {
    const y = e.touches[0]?.clientY
    if (touchYRef.current != null && y != null && y > touchYRef.current + 6) {
      setPinned(false)
    }
    touchYRef.current = y ?? null
  }

  function jumpToBottom() {
    setPinned(true)
    scrollToBottom()
  }

  useEffect(() => {
    if (!pinBottomRef.current) return
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      scrollToBottom()
    })
    return () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [messages, status])

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setPinned(true)
    await sendMessage({ text }, { body: { sessionId } })
  }

  function switchSession(id?: string) {
    if (busy) {
      message.warning('Wait for the current response to finish before switching sessions')
      return
    }
    navigate(id ? `/chat?session=${id}` : '/chat')
  }

  async function onNew() {
    if (busy) {
      message.warning('Wait for the current response to finish before starting a new chat')
      return
    }
    try {
      const created = await aiApi.createSession()
      loadedSessionRef.current = created.id
      setMessages([])
      navigate(`/chat?session=${created.id}`)
      void loadSessions()
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Creation failed')
    }
  }

  function onRemove(id: string, e: MouseEvent) {
    e.stopPropagation()
    if (busy) {
      message.warning('Wait for the current response to finish before deleting')
      return
    }
    modal.confirm({
      title: 'Delete this conversation?',
      content: 'Deleted conversations cannot be recovered.',
      okText: 'Delete',
      cancelText: 'Cancel',
      okType: 'danger',
      centered: true,
      onOk: async () => {
        try {
          await aiApi.removeSession(id)
          if (sessionId === id) {
            loadedSessionRef.current = undefined
            setMessages([])
            navigate('/chat')
          }
          void loadSessions()
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : 'Delete failed')
          throw err
        }
      },
    })
  }

  return (
    <div className="kh-page kh-chat-layout">
      <aside className="kh-chat-sessions">
        <Button type="primary" icon={<PlusOutlined />} block disabled={busy} onClick={() => void onNew()}>
          New chat
        </Button>
        <div className="kh-chat-session-list">
          {sessions.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No conversations yet" />
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={`kh-chat-session-item${sessionId === s.id ? ' active' : ''}${busy ? ' disabled' : ''}`}
                onClick={() => switchSession(s.id)}
              >
                <div className="kh-chat-session-title">{s.title}</div>
                <div className="kh-chat-session-meta">
                  <span>{formatTime(s.updatedAt)}</span>
                  <DeleteOutlined onClick={(e) => onRemove(s.id, e)} />
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
      <div className="kh-chat-main">
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          Knowledge chat
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          Searches only documents you are allowed to access (public, team-shared, or authored by you). The assistant classifies intent, grades retrieval relevance, rewrites insufficient queries, and searches the web only when allowed.
        </Typography.Paragraph>
        <div className="kh-chat-log-wrap">
          <div
            className="kh-chat-log"
            ref={logRef}
            onScroll={onLogScroll}
            onWheel={onLogWheel}
            onTouchStart={onLogTouchStart}
            onTouchMove={onLogTouchMove}
          >
            {messages.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Ask a question to start a conversation" />
            ) : (
              messages.map((m, i) => {
                const liveAssistant =
                  streaming && m.role === 'assistant' && i === messages.length - 1
                return (
                  <div key={m.id} className={`kh-bubble ${m.role}`}>
                    <ChatMessageParts
                      messageId={m.id}
                      parts={m.parts}
                      role={m.role}
                      showSources={!liveAssistant}
                    />
                  </div>
                )
              })
            )}
            {error ? <div className="kh-chat-error">{error.message}</div> : null}
          </div>
          {showJump ? (
            <Button
              className="kh-chat-jump"
              size="small"
              icon={<DownOutlined />}
              onClick={jumpToBottom}
            >
              Jump to bottom
            </Button>
          ) : null}
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            size="large"
            placeholder="Example: How should we validate a canary release?"
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={() => void send()}
          />
          {streaming ? (
            <Button size="large" onClick={() => void stop()}>
              Stop
            </Button>
          ) : (
            <Button type="primary" size="large" onClick={() => void send()}>
              Send
            </Button>
          )}
        </Space.Compact>
      </div>
    </div>
  )
}
