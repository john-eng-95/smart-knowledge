import { RoleCode } from './roles';

/** Permission codes used for runtime authorization checks. */
export const PermissionCode = {
  documentList: 'document:list',
  documentCreate: 'document:create',
  documentEdit: 'document:edit',
  documentDelete: 'document:delete',
  documentReview: 'document:review',
  search: 'search',
} as const;

/** Operation permissions automatically granted to administrators. */
export const ADMIN_OPERATION_PERMISSIONS = [
  'document:list',
  'document:create',
  'document:edit',
  'document:delete',
  'document:review',
  'document:category',
  'document:category:query',
  'document:tag',
  'document:version',
  'search',
  'system:user',
  'system:role',
  'system:permission',
  'system:permission:create',
  'system:permission:edit',
  'system:permission:delete',
  'system:team',
  'system:statistics',
  'system:settings',
] as const;

export const ADMIN_ROLES = [RoleCode.ADMIN] as const;

/** 1 = menu, 2 = button, 3 = API. */
export enum PermissionType {
  Menu = 1,
  Button = 2,
  Api = 3,
}
