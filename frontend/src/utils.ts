import type { AuthUser, TeamItem, TeamTreeNode } from './types'

export const DOC_STATUS: Record<number, { label: string; color: string }> = {
  0: { label: 'Draft', color: 'default' },
  1: { label: 'Published', color: 'success' },
  2: { label: 'Archived', color: 'warning' },
  3: { label: 'Pending review', color: 'processing' },
}

export function formatTime(value?: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function can(user: AuthUser | null, code: string) {
  if (!user) return false
  if (user.roles.includes('ROLE_ADMIN')) return true
  return user.permissions.includes(code)
}

export function isAdmin(user: AuthUser | null) {
  return Boolean(user?.roles.includes('ROLE_ADMIN'))
}

export function isReviewer(user: AuthUser | null) {
  return Boolean(
    user?.roles.includes('ROLE_ADMIN') || user?.roles.includes('ROLE_REVIEWER'),
  )
}

/** Authors and administrators can edit documents. */
export function canWriteDocument(
  user: AuthUser | null,
  doc: { authorId?: string | null },
) {
  if (!user) return false
  if (isAdmin(user)) return true
  return Boolean(doc.authorId && doc.authorId === user.userId)
}

export function visibilityMeta(doc: {
  isPublic?: boolean | null
  teamId?: string | null
}) {
  if (doc.isPublic) return { label: 'Public', color: 'success' as const }
  if (doc.teamId) return { label: 'Team', color: 'blue' as const }
  return { label: 'Private', color: 'default' as const }
}

export function flattenTeams(nodes: TeamTreeNode[] | unknown[]): TeamItem[] {
  const out: TeamItem[] = []
  const walk = (list: unknown[]) => {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const node = raw as TeamTreeNode
      if (node.id && node.teamName) out.push(node)
      if (Array.isArray(node.children) && node.children.length) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

export function displayName(user: AuthUser | null) {
  if (!user) return 'Not signed in'
  return user.realName?.trim() || user.username
}

/** Preserve only em tags in Elasticsearch highlights to prevent XSS. */
export function safeHighlight(html?: string) {
  if (!html) return ''
  return html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;em&gt;/g, '<em>')
    .replace(/&lt;\/em&gt;/g, '</em>')
}
