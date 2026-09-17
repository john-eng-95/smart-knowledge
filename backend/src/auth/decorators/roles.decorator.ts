import { SetMetadata } from '@nestjs/common';
import { RoleCodeValue } from '../../common/constants/roles';

export const ROLES_KEY = 'roles';

/** Require one of the specified roles (used with RolesGuard). */
export const Roles = (...roles: RoleCodeValue[]) =>
  SetMetadata(ROLES_KEY, roles);
