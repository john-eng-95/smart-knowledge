/** Built-in role codes matching kh_role.role_code. */
export const RoleCode = {
  ADMIN: 'ROLE_ADMIN',
  REVIEWER: 'ROLE_REVIEWER',
  USER: 'ROLE_USER',
} as const;

export type RoleCodeValue = (typeof RoleCode)[keyof typeof RoleCode];
