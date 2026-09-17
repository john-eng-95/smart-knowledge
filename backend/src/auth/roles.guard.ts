import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from './auth-user.interface';
import { ROLES_KEY } from './decorators/roles.decorator';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { RoleCodeValue } from '../common/constants/roles';

/**
 * Role guard.
 *
 * <p>Runs after {@link JwtAuthGuard} (both are APP_GUARD providers, registered as JWT then roles).</p>
 *
 * <p>Rules:</p>
 * <ul>
 *   <li>Endpoints without {@link Roles} metadata are allowed for authenticated users.</li>
 *   <li>Endpoints marked with {@code @Roles('ROLE_REVIEWER', ...)} require a matching request.user.roles entry.</li>
 *   <li>Otherwise, return 403 Forbidden.</li>
 * </ul>
 *
 * <p>Example: document approve/reject requires {@code ROLE_REVIEWER} or {@code ROLE_ADMIN}.</p>
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<RoleCodeValue[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user?.roles?.length) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const ok = requiredRoles.some((role) => user.roles.includes(role));
    if (!ok) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
