import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

/**
 * Global JWT authentication guard.
 *
 * <p>Registered through {@code APP_GUARD} in {@link AuthModule}; all HTTP endpoints require authentication by default.</p>
 *
 * <p>Execution order (canActivate):</p>
 * <ol>
 *   <li>Read {@link Public} metadata and allow public endpoints (login / register / refresh).</li>
 *   <li>Otherwise call the parent {@link AuthGuard}('jwt') to invoke {@link JwtStrategy}.</li>
 * </ol>
 *
 * <p>{@link handleRequest} maps signature failures and validate errors to 401.</p>
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }

  /** Passport callback: missing user or a strategy error becomes 401. */
  handleRequest<TUser>(err: Error | null, user: TUser): TUser {
    if (err || !user) {
      throw err ?? new UnauthorizedException('Not signed in or token expired');
    }
    return user;
  }
}
