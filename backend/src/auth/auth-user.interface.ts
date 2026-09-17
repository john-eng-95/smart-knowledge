/** Current user injected into controllers after JWT validation. */
export interface AuthUser {
  userId: string;
  username: string;
  realName?: string | null;
  email?: string | null;
  avatar?: string | null;
  roles: string[];
  permissions: string[];
  /** Teams the user belongs to, including teams they lead, for document visibility. */
  teamIds: string[];
}
