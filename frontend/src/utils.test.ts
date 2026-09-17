import { describe, expect, it } from 'vitest'
import {
  can,
  canWriteDocument,
  displayName,
  flattenTeams,
  isAdmin,
  isReviewer,
  safeHighlight,
} from './utils'
import type { AuthUser } from './types'

const user: AuthUser = {
  userId: 'user-1',
  username: 'reader',
  roles: ['ROLE_USER'],
  permissions: ['document:list'],
}

describe('authorization helpers', () => {
  it('checks permissions and grants administrators all permissions', () => {
    expect(can(null, 'document:list')).toBe(false)
    expect(can(user, 'document:list')).toBe(true)
    expect(can(user, 'document:delete')).toBe(false)
    expect(can({ ...user, roles: ['ROLE_ADMIN'] }, 'document:delete')).toBe(true)
  })

  it('recognizes administrator and reviewer roles', () => {
    expect(isAdmin(user)).toBe(false)
    expect(isAdmin({ ...user, roles: ['ROLE_ADMIN'] })).toBe(true)
    expect(isReviewer({ ...user, roles: ['ROLE_REVIEWER'] })).toBe(true)
    expect(isReviewer(user)).toBe(false)
  })

  it('allows document writes to the author or an administrator', () => {
    expect(canWriteDocument(user, { authorId: 'user-1' })).toBe(true)
    expect(canWriteDocument(user, { authorId: 'user-2' })).toBe(false)
    expect(
      canWriteDocument({ ...user, roles: ['ROLE_ADMIN'] }, { authorId: null }),
    ).toBe(true)
  })
})

describe('display helpers', () => {
  it('uses a trimmed real name and falls back to the username', () => {
    expect(displayName({ ...user, realName: '  Reader  ' })).toBe('Reader')
    expect(displayName(user)).toBe('reader')
    expect(displayName(null)).toBeTruthy()
  })

  it('flattens nested teams and ignores malformed entries', () => {
    expect(
      flattenTeams([
        {
          id: 'team-1',
          teamName: 'Engineering',
          children: [{ id: 'team-2', teamName: 'Platform' }],
        },
        { id: 'invalid' },
        null,
      ]),
    ).toHaveLength(2)
  })

  it('escapes markup while preserving the supported highlight tags', () => {
    expect(safeHighlight('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
    expect(safeHighlight('<em>match</em>')).toBe('<em>match</em>')
    expect(safeHighlight()).toBe('')
  })
})
