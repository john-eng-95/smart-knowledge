import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from '../auth-user.interface';

/** Read the current user from request.user (requires JwtAuthGuard). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return request.user;
  },
);
