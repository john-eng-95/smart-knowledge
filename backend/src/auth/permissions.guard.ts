import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from './auth-user.interface';
import { PERMISSIONS_KEY } from './decorators/require-permission.decorator';
import { RoleCode } from '../common/constants/roles';

/**
 * Permission guard (runs after JwtAuthGuard and RolesGuard).
 *
 * - No @RequirePermission metadata -> allow.
 * - ROLE_ADMIN -> allow.
 * - Otherwise, request.user.permissions must contain a required permission.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Insufficient permissions');
    }

    if (user.roles.includes(RoleCode.ADMIN)) {
      return true;
    }

    const owned = new Set(user.permissions ?? []);
    const ok = required.some((p) => owned.has(p));
    if (!ok) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
